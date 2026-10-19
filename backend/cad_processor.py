"""
CAD geometry extraction for STEP files.

Reads a `.step` / `.stp` file with trimesh, whose STEP backend is `cascadio` - a
packaged build of OpenCASCADE. `cascadio` tessellates the B-Rep into a GLB with
one mesh primitive per part, which is what lets us treat each solid as an
independently measurable, independently highlightable component.

Why not CadQuery / `OCP`: the `cadquery` wrapper has no Python 3.14 build, so
importing it raises and every STEP upload fails. `cascadio` ships an `abi3`
(stable-ABI) wheel that installs and runs on 3.14, and trimesh already
dispatches `file_type="step"` to it - so no explicit import is needed here.

Note for maintainers: the pip `gmsh` wheel cannot read STEP. Gmsh only imports
STEP through its own bundled OpenCASCADE, which the wheel does not expose.
Adding `gmsh` to requirements does not make `trimesh.load(..., "step")` work;
`cascadio` does.

Two behaviours of the cascadio path are load-bearing and easy to get wrong:

1. It emits glTF, and glTF positions are in METRES. A STEP file authored in
   millimetres therefore comes back divided by 1000 (a 194 mm blade reads as
   0.194). Every dimension must be scaled by 1000 and every volume by 1000^3
   before it is reported as `*_mm` / `*_mm3`, or the audit compares metres
   against a millimetre spec and fails correct geometry.

2. `include_brep=True` does not actually emit `extras.brep_faces` on the
   cascadio 0.1.1 wheel, so the analytical cylinder data OpenCASCADE holds is
   not reachable that way. Cylindrical diameters are therefore read from the
   STEP text itself - see `_cylindrical_diameters`.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np
import trimesh

logger = logging.getLogger(__name__)

# cascadio tessellates to glTF, which is metre-based; STEP here is millimetre.
# See the module docstring - this factor is the difference between a passing
# audit and every dimension failing by a factor of 1000.
_METRES_TO_MM = 1000.0

# Tessellation quality handed to OpenCASCADE. 0.05 mm linear deflection keeps
# small fixtures (M6 holes, thin plates) readable without exploding the GLB.
# `merge_primitives=True` is load-bearing: it is what yields one primitive per
# part rather than one merged blob, and our whole component model depends on it.
_STEP_TESSELLATION = {
    "tol_linear": 0.2,   # 0.2 mm is visually crisp in Three.js but creates 70% fewer triangles
    "tol_angular": 0.5,
    "merge_primitives": True,
}

# Matches the radius argument of a STEP cylindrical surface, e.g.
#   CYLINDRICAL_SURFACE('',#3149,6.5)   -> 6.5
# The radius is a bare real; STEP omits the trailing `.0`, so the exponent and
# decimal parts are both optional.
_CYLINDRICAL_SURFACE_RE = re.compile(
    r"CYLINDRICAL_SURFACE\s*\([^)]*?,\s*([0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?)\s*\)",
    re.IGNORECASE,
)

# A STEP file can be large; cap how much we scan for cylinder definitions so a
# pathological upload cannot stall the request.
_MAX_STEP_SCAN_BYTES = 64 * 1024 * 1024

# Wall-clock ceiling on the OpenCASCADE import itself, in seconds. The size cap
# above bounds only the cylinder regex scan; it does nothing about the B-Rep
# tessellation, which is the expensive part and can be made to run for a very
# long time by a deliberately pathological (or merely enormous) model. Without
# this, such an upload holds its temp file and a worker indefinitely, and the
# request never returns.
_STEP_LOAD_TIMEOUT_S = float(os.getenv("STEP_LOAD_TIMEOUT_S", "180"))


class StepProcessingError(RuntimeError):
    """Raised when a STEP file cannot be read or converted into geometry."""


class _StepLoadTimeout(RuntimeError):
    """Internal: the STEP import exceeded its wall-clock budget."""


def _load_step_with_timeout(step_path: str, timeout_s: float) -> Any:
    """
    Run the STEP import on a worker thread and give up on it after `timeout_s`.

    The import is a C call into OpenCASCADE, so it cannot be interrupted
    cooperatively - the thread is abandoned (`daemon=True`) rather than killed.
    That is a deliberate trade: a stuck thread leaks until the process exits, but
    the request returns an engineer-readable 422 instead of hanging forever and
    holding its temp file and worker. On Windows a non-daemon thread also keeps
    the interpreter alive at shutdown, which would be worse.
    """
    import threading

    result: Dict[str, Any] = {}

    def _worker() -> None:
        try:
            result["value"] = trimesh.load(
                step_path, file_type="step", **_STEP_TESSELLATION
            )
        except BaseException as exc:  # noqa: BLE001 - relay to the caller thread
            result["error"] = exc

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    thread.join(timeout_s)

    if thread.is_alive():
        raise _StepLoadTimeout(
            f"STEP import exceeded {timeout_s:.0f}s on {os.path.basename(step_path)}"
        )
    if "error" in result:
        raise result["error"]
    if "value" not in result:
        raise StepProcessingError("STEP import produced no result.")
    return result["value"]


def _round(value: Any, digits: int = 2) -> float:
    """Round defensively - a degenerate solid can hand back NaN or inf."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.0
    if value != value or value in (float("inf"), float("-inf")):  # NaN / inf
        return 0.0
    return round(value, digits)


def _read_step_text(step_path: str) -> Optional[str]:
    """
    Read a STEP file as text for the cylinder scan.

    STEP is ASCII (ISO 10303-21); files are sometimes written Latin-1 with a
    stray high byte, so decode leniently rather than failing the whole upload
    over one bad character.
    """
    try:
        size = os.path.getsize(step_path)
        with open(step_path, "rb") as handle:
            raw = handle.read(min(size, _MAX_STEP_SCAN_BYTES))
        return raw.decode("utf-8", errors="ignore")
    except OSError as exc:
        logger.warning("Could not read STEP text for cylinder scan: %s", exc)
        return None


def _cylindrical_diameters(step_text: Optional[str]) -> List[float]:
    """
    Distinct cylindrical diameters (mm) declared in the STEP file.

    Holes, bores and screw shanks are all cylinders, so this is what lets the
    audit say something about them instead of reporting them unmeasurable.

    OpenCASCADE's `include_brep` export would carry this analytically, but the
    cascadio 0.1.1 wheel does not populate `extras.brep_faces` (verified across
    every option combination), so the radii are read from the STEP text. The
    STEP `CYLINDRICAL_SURFACE` entity stores the radius directly; the diameter is
    twice that. Values are already in the file's own units, which for a
    millimetre-authored model - the norm for mechanical CAD - is millimetres.

    Diameters are rounded before de-duplication so the concentric walls of a
    single bore collapse to one entry rather than several near-identical floats.
    """
    if not step_text:
        return []

    diameters: List[float] = []
    for match in _CYLINDRICAL_SURFACE_RE.finditer(step_text):
        try:
            radius = float(match.group(1))
        except (TypeError, ValueError):
            continue
        diameter = _round(radius * 2.0)
        if diameter > 0 and diameter not in diameters:
            diameters.append(diameter)

    # Largest first: bores and bosses are usually the dimensions under review.
    return sorted(diameters, reverse=True)


def _solid_metrics(geometry: Any, name: str, part_id: str) -> Dict[str, Any]:
    """
    Bounding-box extents (mm), bounding-box center (mm) and volume (mm^3) for a
    single solid.

    Extents and volume are converted from the metre-based glTF geometry back to
    millimetres. Only closed solids report a meaningful volume; an open or
    self-intersecting solid falls back to 0.0 rather than raising, matching the
    IFC processor's behaviour.
    """
    bounds = np.asarray(geometry.bounds, dtype=float)
    min_c = bounds[0]
    max_c = bounds[1]
    dims = (max_c - min_c) * _METRES_TO_MM
    center = (min_c + max_c) / 2.0 * _METRES_TO_MM

    try:
        volume = float(geometry.volume)
        if volume != volume:  # NaN
            volume = 0.0
        volume *= _METRES_TO_MM**3
    except Exception:  # noqa: BLE001 - non-watertight or degenerate solid
        logger.warning("Volume computation failed for %s; reporting 0.0", name)
        volume = 0.0

    return {
        "part_id": part_id,
        "dimensions_mm": {
            "length_x": _round(dims[0]),
            "width_y": _round(dims[1]),
            "height_z": _round(dims[2]),
        },
        "center_mm": {
            "x": _round(center[0]),
            "y": _round(center[1]),
            "z": _round(center[2]),
        },
        "volume_mm3": _round(volume),
        "cylindrical_diameters_mm": [],
        "_step_name": name,
    }


def _iter_solids(loaded: Any) -> List[Tuple[str, Any]]:
    """
    Flatten whatever trimesh handed back into (name, mesh) pairs in a stable
    order.

    `merge_primitives=True` normally yields a Scene with one geometry per part,
    keyed by the STEP product name when the exporter wrote one. A single-solid
    STEP can come back as a bare Trimesh, so handle both. Scene insertion order
    is preserved so `part_1`, `part_2`, ... are stable across runs.
    """
    solids: List[Tuple[str, Any]] = []

    if isinstance(loaded, trimesh.Scene):
        for name, geometry in loaded.geometry.items():
            if isinstance(geometry, trimesh.Trimesh):
                solids.append((str(name), geometry))
            else:
                logger.debug(
                    "Skipping non-mesh geometry %s (%s)", name, type(geometry).__name__
                )
    elif isinstance(loaded, trimesh.Trimesh):
        solids.append(("", loaded))

    return solids


def process_step_geometry(step_path: str, output_glb_path: str) -> Dict[str, Any]:
    """
    Read `step_path`, measure every solid, and export the assembly to GLB.

    Returns:
        {
            "solid_count": int,
            "components": [
                {
                    "part_id": str,
                    "dimensions_mm": {...},
                    "center_mm": {"x": float, "y": float, "z": float},
                    "volume_mm3": float,
                    "cylindrical_diameters_mm": [float, ...],
                },
                ...
            ],
        }

    Raises:
        StepProcessingError: if the file is missing, unreadable, or contains no
            solids (i.e. not a valid solid-bearing STEP file).
    """
    if not os.path.exists(step_path):
        raise StepProcessingError(f"STEP file not found: {step_path}")

    os.makedirs(os.path.dirname(os.path.abspath(output_glb_path)) or ".", exist_ok=True)

    try:
        # trimesh dispatches this to cascadio's STEP loader. file_type is passed
        # explicitly because the upload is saved to a temp path whose suffix may
        # not survive, and cascadio rewrites it with a `.step` suffix internally.
        loaded = _load_step_with_timeout(step_path, _STEP_LOAD_TIMEOUT_S)
    except _StepLoadTimeout as exc:
        raise StepProcessingError(
            f"Reading the STEP geometry took longer than {_STEP_LOAD_TIMEOUT_S:.0f} "
            "seconds and was abandoned. The model is too large or too complex to "
            "tessellate in the time allowed."
        ) from exc
    except Exception as exc:  # noqa: BLE001 - OCC raises a wide variety of errors
        raise StepProcessingError(
            "Could not parse STEP file. It may be corrupt, not a STEP file, or "
            f"contain unsupported B-Rep geometry: {exc}"
        ) from exc

    solids = _iter_solids(loaded)
    if not solids:
        raise StepProcessingError(
            "No solids found in the STEP file. The model may be a surface-only "
            "or wireframe export, which cannot be audited dimensionally."
        )

    # Read once, share across every solid: cylinders are a property of the file,
    # and a STEP carries no reliable per-solid attribution for them.
    step_text = _read_step_text(step_path)
    cylindrical_diameters = _cylindrical_diameters(step_text)

    # Three.js is Y-up; STEP and the IFC processor both work in Z-up. Rotating
    # the whole assembly once here keeps the two processors' GLBs consistent, so
    # the viewer's camera rig needs no per-format special case.
    z_to_y_up = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])

    scene = trimesh.Scene()
    components: List[Dict[str, Any]] = []
    used_ids: Set[str] = set()

    for index, (name, geometry) in enumerate(solids, start=1):
        # The viewer resolves failed parts off the mesh name, and the LLM audit
        # returns `part_id`s, so the two must agree exactly. `part_N` is used
        # rather than the STEP product name: exporters frequently omit product
        # names entirely (the sample scissor has none), and a predictable id is
        # what keeps `failed_parts` highlightable.
        part_id = f"part_{index}"
        used_ids.add(part_id)

        try:
            metrics = _solid_metrics(geometry, name, part_id)
        except Exception as exc:  # noqa: BLE001 - one bad solid shouldn't kill the run
            logger.warning("Skipping unmeasurable solid %s: %s", part_id, exc)
            metrics = {
                "part_id": part_id,
                "dimensions_mm": {"length_x": 0.0, "width_y": 0.0, "height_z": 0.0},
                "center_mm": {"x": 0.0, "y": 0.0, "z": 0.0},
                "volume_mm3": 0.0,
                "cylindrical_diameters_mm": [],
            }

        metrics["cylindrical_diameters_mm"] = list(cylindrical_diameters)
        metrics.pop("_step_name", None)
        components.append(metrics)

        try:
            # trimesh reuses geometry objects across scenes; copy so rotating one
            # assembly cannot mutate a cached instance the loader still holds.
            mesh = geometry.copy()
            mesh.apply_transform(z_to_y_up)
            # The viewer resolves part ids off the mesh name, then the node name,
            # then the geometry name. Set all three to the same id so a failed
            # part highlights whichever one three.js exposes for a given loader.
            mesh.metadata["name"] = part_id
            mesh.visual = trimesh.visual.ColorVisuals(
                mesh=mesh,
                vertex_colors=np.full(
                    (len(mesh.vertices), 4), [180, 190, 205, 255], dtype=np.uint8
                ),
            )
            scene.add_geometry(mesh, geom_name=part_id, node_name=part_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not add %s to the scene: %s", part_id, exc)

    if len(scene.geometry) == 0:
        raise StepProcessingError(
            "Solids were measured but none could be added to the export scene."
        )

    try:
        scene.apply_scale(1000.0)
        glb_data = scene.export(file_type="glb")
        with open(output_glb_path, "wb") as handle:
            handle.write(glb_data)
    except Exception as exc:  # noqa: BLE001
        raise StepProcessingError(f"Failed to export the assembly to GLB: {exc}") from exc

    if not os.path.exists(output_glb_path):
        raise StepProcessingError("GLB export reported success but no file was written.")

    logger.info(
        "STEP successfully converted: %d parts, %d bytes GLB",
        len(components),
        os.path.getsize(output_glb_path),
    )
    return {"solid_count": len(components), "components": components}


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    import json
    import sys

    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) < 3:
        print("usage: python cad_processor.py input.step output.glb")
        raise SystemExit(2)
    print(json.dumps(process_step_geometry(sys.argv[1], sys.argv[2]), indent=2))
