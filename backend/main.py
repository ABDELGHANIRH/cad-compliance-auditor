"""
CAD Compliance Auditor - FastAPI service.

Receives a STEP or IFC file plus a textual engineering specification, extracts
the geometry, converts it to GLB for browser rendering, and asks an LLM to audit
the measured dimensions against the spec.
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from typing import Any, Dict, List, Set, Tuple

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auditor import audit_against_specs
from cad_processor import StepProcessingError, process_step_geometry
from clash_detector import detect_clashes
from ifc_processor import IfcProcessingError, process_ifc


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("cad_auditor")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
MODELS_DIR = os.path.join(STATIC_DIR, "models")

# Created eagerly so a fresh clone never hits FileNotFoundError on first upload.
os.makedirs(MODELS_DIR, exist_ok=True)

MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB
STEP_EXTENSIONS = (".step", ".stp")
IFC_EXTENSIONS = (".ifc",)
ALLOWED_EXTENSIONS = STEP_EXTENSIONS + IFC_EXTENSIONS

# Separation (mm) below which a non-touching pair is reported as a near-miss in
# addition to true interferences. 0.0 reports interferences only, which is the
# right default for mechanical assemblies: mating faces meet at zero gap.
CLEARANCE_MM = 0.0

app = FastAPI(
    title="CAD Compliance Auditor",
    description="Audits STEP and IFC geometry against textual engineering requirements.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # must be False when allow_origins is ["*"]
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class ComponentDimensions(BaseModel):
    length_x: float
    width_y: float
    height_z: float


class ComponentCenter(BaseModel):
    x: float
    y: float
    z: float


class CadComponent(BaseModel):
    part_id: str
    dimensions_mm: ComponentDimensions
    volume_mm3: float
    # Distinct cylindrical face diameters (mm), largest first. Holes, bores and
    # screw shanks live here; empty when the solid has no cylindrical features.
    # Always empty for IFC input - see ifc_processor.
    cylindrical_diameters_mm: list[float] = []
    # Centre of the solid's bounding box (mm). Emitted by both processors; the
    # viewer falls back to the mesh origin when it is absent.
    center_mm: ComponentCenter | None = None
    # BIM fields, present only for IFC input and only when the element carries
    # them. `properties` is a flat map of "<Pset>.<Property>" -> value.
    ifc_class: str | None = None
    predefined_type: str | None = None
    type_name: str | None = None
    material: str | None = None
    properties: Dict[str, Any] | None = None
    # Which dropzone slot this solid was uploaded in: "A" or "B". Absent on
    # a single-model audit. Lets the model tree separate the two federated
    # files once their part names have been re-keyed into one namespace.
    discipline: str | None = None


class CadMetrics(BaseModel):
    solid_count: int
    components: list[CadComponent]


class CheckItem(BaseModel):
    check_name: str
    part_id: str
    status: str
    expected: str
    found: str
    fix_instruction: str = ""
    # The plain-English review, as three "**Label:** sentence" paragraphs -
    # Status, Measurement, Recommended Action. Always populated by
    # auditor._normalise, which assembles it from the model's plain_* fields
    # (or synthesises an equivalent from whatever it did send) and scrubs any
    # geometry jargon that leaked through.
    comment: str = ""


class Interference(BaseModel):
    """One pair of components whose bounding boxes overlap."""

    part_a: str
    part_b: str
    overlap_mm: Dict[str, float]
    # Smallest of the three axis overlaps: how far the parts must separate
    # along that axis before they stop interfering.
    penetration_mm: float


class Clearance(BaseModel):
    """A pair that does not touch but sits closer than the clearance threshold."""

    part_a: str
    part_b: str
    gap_mm: float


class BoxOverlap(BaseModel):
    """
    A pair of boxes that overlap, with the measured extent of the overlap.

    Carries the same fields as an interference because the detector produces
    them the same way; what separates the two is the band the pair landed in,
    which is expressed by which list it appears in.
    """

    part_a: str
    part_b: str
    overlap_mm: Dict[str, float]
    penetration_mm: float


class Containment(BaseModel):
    """
    One box largely enclosing another: a part mounted inside a frame.

    Normal on a process skid, and excluded from the verdict for that reason. It
    reaches the client so the reviewer can see which pairs the check set aside -
    a part silently absent from the findings is indistinguishable from a part
    that was never measured.
    """

    part_a: str
    part_b: str
    contained: str
    host: str
    overlap_ratio: float
    penetration_mm: float


class ExcludedPart(BaseModel):
    part_id: str
    reason: str


class ClashResult(BaseModel):
    """
    Deterministic geometric pre-check, computed before the LLM audit.

    This is the reproducible half of the verdict: same input, same result. It is
    passed to the LLM as verified fact rather than left for the model to infer
    from centre coordinates.
    """

    checked_pairs: int
    excluded_parts: list[ExcludedPart] = []
    interferences: list[Interference] = []
    # Box overlaps too shallow to be called a clash, and pairs where one part is
    # mounted inside another. Both bands are reported rather than dropped, so a
    # pair the check looked at and set aside is still visible to the reviewer.
    #
    # Every field on this model must be declared: pydantic drops what it does
    # not know about, so a band computed in the detector but missing here would
    # vanish silently between the two - which is exactly what happened when the
    # containment rule was first added.
    grazes: list[BoxOverlap] = []
    containments: list[Containment] = []
    min_reportable_overlap_mm: float | None = None
    containment_ratio: float | None = None
    clearances: list[Clearance] = []
    # Always present: a bounding-box test is conservative, not exact, and the
    # UI is expected to surface this rather than present a clash as confirmed.
    caveat: str


class AuditResult(BaseModel):
    overall_status: str
    summary: str
    failed_parts: list[str]
    checks: list[CheckItem]


class DisciplineModels(BaseModel):
    """
    Per-discipline GLBs for a federated (two-file) audit.

    A federated audit has to be visible as two separately toggleable models,
    which a single merged GLB cannot express, so each discipline is exported and
    measured in its own frame. The merged metrics below are what the audit and
    the clash pre-check run on; these are what the viewer renders.
    """

    disciplineA: ModelSlot | None = None
    disciplineB: ModelSlot | None = None


class ModelSlot(BaseModel):
    model_url: str
    cad_metrics: CadMetrics


class AuditResponse(BaseModel):
    model_url: str
    cad_metrics: CadMetrics
    clash: ClashResult
    audit: AuditResult
    # Omitted entirely for a single-file audit, so the pre-federation response
    # shape is unchanged for every existing caller.
    models: DisciplineModels | None = None


def _model_url_from_path(glb_path: str) -> str:
    """
    Build a root-relative URL for a GLB inside static/models/.

    The frontend proxies /static to this service, so a relative URL renders
    identically whether the page is on localhost:3000 or 127.0.0.1:3000.
    """
    filename = os.path.basename(glb_path)
    return "/static/models/" + filename


def _remove_temp_file(path: str, attempts: int = 5) -> None:
    """
    Delete a temp upload, tolerating Windows' brief post-read handle release.

    OpenCASCADE (via cascadio) reads the STEP through its own file handle. Even
    though it closes before returning, Windows may reject the unlink for a few
    milliseconds. Retrying a handful of times clears it in practice; if it still
    fails we log and move on, because a leftover file in %TEMP% must never turn
    a successful audit into an error response.
    """
    for attempt in range(attempts):
        try:
            if not os.path.exists(path):
                return
            os.remove(path)
            return
        except OSError:
            if attempt == attempts - 1:
                logger.warning("Could not remove temp file %s", path)
                return
            time.sleep(0.05 * (attempt + 1))


def _unique_part_id(raw_name: str, used: Set[str]) -> str:
    """
    Make `raw_name` unique within `used`, and record it.

    Mirrors ifc_processor._unique_part_id: two disciplines can legitimately
    contain identically-named parts, and a duplicate `part_id` would make one of
    them unreachable everywhere downstream.
    """
    candidate = raw_name or "part"
    if candidate not in used:
        used.add(candidate)
        return candidate

    suffix = 2
    while f"{candidate}_{suffix}" in used:
        suffix += 1
    unique = f"{candidate}_{suffix}"
    used.add(unique)
    return unique


async def _store_upload(upload: UploadFile, run_id: str, label: str) -> Tuple[str, bool, str]:
    """
    Write one uploaded model to a temp file and classify its format.

    Returns (temp_path, is_ifc, original_filename). The caller owns the temp
    file and must remove it - the two uploads are written before either is read,
    so they cannot share a single try/finally around one of them.
    """
    filename = upload.filename or "upload.step"
    lowered = filename.lower()

    if lowered.endswith(IFC_EXTENSIONS):
        is_ifc = True
    elif lowered.endswith(STEP_EXTENSIONS):
        is_ifc = False
    else:
        raise HTTPException(
            status_code=400,
            detail=f"{label}: unsupported file type. Upload a .step, .stp or .ifc file.",
        )

    if not upload.filename:
        logger.warning("%s arrived with no filename; assuming %s", label, filename)

    # mkstemp hands back an open fd. It must be closed before anything reads the
    # file - on Windows an open handle locks it against the geometry backend.
    # The suffix must match the real format: both backends sniff the extension,
    # and cascadio rewrites the temp copy with a `.step` suffix internally.
    tmp_fd, tmp_path = tempfile.mkstemp(
        suffix=".ifc" if is_ifc else ".step", prefix=f"upload_{run_id}_{label}_"
    )
    os.close(tmp_fd)

    written = 0
    try:
        with open(tmp_path, "wb") as buffer:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"{label}: CAD file exceeds the 100 MB upload limit.",
                    )
                buffer.write(chunk)
    except Exception:
        # The request failed mid-write; the caller's cleanup never sees this path.
        _remove_temp_file(tmp_path)
        raise
    finally:
        await upload.close()

    if written == 0:
        _remove_temp_file(tmp_path)
        raise HTTPException(status_code=400, detail=f"{label}: the uploaded file is empty.")

    logger.info(
        "Received %s (%d bytes) as run %s [%s]",
        filename,
        written,
        run_id,
        "ifc" if is_ifc else "step",
    )
    return tmp_path, is_ifc, filename


def _process_geometry(tmp_path: str, is_ifc: bool, glb_path: str, run_id: str) -> Dict[str, Any]:
    """Run the format-appropriate geometry backend, translating its errors."""
    try:
        if is_ifc:
            return process_ifc(tmp_path, glb_path)
        return process_step_geometry(tmp_path, glb_path)
    except (StepProcessingError, IfcProcessingError) as exc:
        # The message is already engineer-readable - surface it directly.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected geometry failure for run %s", run_id)
        raise HTTPException(
            status_code=500,
            detail="Unexpected error while reading the CAD geometry: " + str(exc),
        ) from exc


def _merge_discipline_metrics(
    label: str, metrics: Dict[str, Any], used_ids: Set[str]
) -> List[Dict[str, Any]]:
    """
    Re-key one discipline's parts into the shared `part_<n>` namespace.

    Both processors number their own solids from `part_1`, so two disciplines
    would otherwise both contribute a `part_1` - and since the audit, the clash
    pre-check and the viewer all key off `part_id`, that collision would make a
    finding unfixable in the 3D view: the viewer would highlight whichever mesh
    happened to match first.
    """
    merged: List[Dict[str, Any]] = []
    for component in metrics.get("components", []):
        original_id = str(component.get("part_id", ""))
        renamed = dict(component)
        renamed["part_id"] = _unique_part_id(f"{label}_{original_id}", used_ids)
        # Which discipline a solid came from, not what it is called: surfaced in
        # the model tree so the two federated files stay distinguishable once
        # their own part names have been rewritten.
        renamed["discipline"] = label
        merged.append(renamed)
    return merged


@app.get("/api/health")
async def health() -> Dict[str, Any]:
    """Liveness probe - also confirms the static model directory is writable."""
    return {
        "status": "ok",
        "static_dir": STATIC_DIR,
        "models_dir_writable": os.access(MODELS_DIR, os.W_OK),
    }


@app.post("/api/audit", response_model=AuditResponse)
async def audit(
    step_file: UploadFile = File(...),
    requirements: str = Form(...),
    discipline_b_file: UploadFile | None = File(None),
):
    """
    Audit an uploaded CAD file against a textual specification.

    Accepts STEP (.step/.stp) and IFC (.ifc); the extension selects the geometry
    backend, and both return the same metrics shape so everything downstream is
    format-agnostic.

    `discipline_b_file` is optional. When present the two uploads are treated as
    two disciplines of ONE federated assembly: each is measured and exported to
    its own GLB (so the viewer can toggle them apart), their components are
    merged into a single metric set under one part-id namespace, and the clash
    pre-check runs across the union - which is what makes an inter-discipline
    interference detectable at all.

    Pipeline: save uploads -> import geometry -> export GLB(s) -> delete temp
    files -> clash pre-check -> LLM conformance audit -> return model URLs, raw
    metrics and verdict.
    """
    os.makedirs(MODELS_DIR, exist_ok=True)

    run_id = uuid.uuid4().hex
    # Always allocate discipline A's GLB: it is the model the viewer opens on,
    # whichever slot the upload came from.
    glb_a = os.path.join(MODELS_DIR, "model_" + run_id + ".glb")
    glb_b = os.path.join(MODELS_DIR, "model_" + run_id + "_b.glb")

    has_second = discipline_b_file is not None and bool(discipline_b_file.filename)

    stored_a: Tuple[str, bool, str] | None = None
    stored_b: Tuple[str, bool, str] | None = None

    try:
        stored_a = await _store_upload(step_file, run_id, "A")
        if has_second:
            assert discipline_b_file is not None  # narrowed by `has_second`
            stored_b = await _store_upload(discipline_b_file, run_id, "B")

        path_a, is_ifc_a, name_a = stored_a
        metrics_a = _process_geometry(path_a, is_ifc_a, glb_a, run_id)

        models_payload: Dict[str, Any] | None = None

        if stored_b is None:
            cad_metrics = metrics_a
        else:
            path_b, is_ifc_b, name_b = stored_b
            metrics_b = _process_geometry(path_b, is_ifc_b, glb_b, run_id)

            # One namespace across both disciplines, so `failed_parts` from the
            # audit, the clash pairs and the mesh names in the GLBs all agree.
            used_ids: Set[str] = set()
            merged_components = _merge_discipline_metrics("A", metrics_a, used_ids)
            merged_components += _merge_discipline_metrics("B", metrics_b, used_ids)
            cad_metrics = {
                "solid_count": len(merged_components),
                "components": merged_components,
            }

            models_payload = {
                "disciplineA": {
                    "model_url": _model_url_from_path(glb_a),
                    "cad_metrics": cad_metrics,
                },
                "disciplineB": {
                    "model_url": _model_url_from_path(glb_b),
                    "cad_metrics": cad_metrics,
                },
            }

            logger.info(
                "Federated run %s: %s (%d parts) + %s (%d parts)",
                run_id,
                name_a,
                len(metrics_a.get("components", [])),
                name_b,
                len(metrics_b.get("components", [])),
            )

    finally:
        # The temp files are only needed for geometry extraction. On Windows the
        # OpenCASCADE reader can hold the handle for a moment after the call
        # returns, so a failed unlink is retried briefly before giving up rather
        # than being treated as fatal - a leaked temp file is not worth a 500.
        for stored in (stored_a, stored_b):
            if stored is not None:
                _remove_temp_file(stored[0])

    # Deterministic clash pre-check. Runs on the measured metrics alone, so it is
    # pure arithmetic on numbers the geometry kernel already produced - no LLM,
    # no file I/O, fully reproducible. The result is handed to the audit as
    # verified fact so interference findings cannot be hallucinated, and it is
    # also returned to the client, which reports it independently of the verdict.
    try:
        clash_result = detect_clashes(cad_metrics, clearance_mm=CLEARANCE_MM)
    except Exception:  # noqa: BLE001 - never let the pre-check fail the request
        logger.exception("Clash pre-check failed for run %s; continuing without it", run_id)
        clash_result = {
            "checked_pairs": 0,
            "excluded_parts": [],
            "interferences": [],
            "grazes": [],
            "containments": [],
            "clearances": [],
            "caveat": "Clash pre-check did not run for this model.",
        }

    audit_result = audit_against_specs(cad_metrics, requirements, clash_result)

    response: Dict[str, Any] = {
        "model_url": _model_url_from_path(glb_a),
        "cad_metrics": cad_metrics,
        "clash": clash_result,
        "audit": audit_result,
    }
    if models_payload is not None:
        response["models"] = models_payload
    return response


if __name__ == "__main__":  # pragma: no cover - convenience for local dev
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)