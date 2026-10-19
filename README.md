# CAD Compliance Auditor

Inspects mechanical 3D `.STEP` files against textual engineering requirements, detects
dimensional discrepancies, and highlights non-compliant components in red inside an
interactive 3D browser viewer.

## How it works

```
  .step file ──┐
               ├─► FastAPI ─► CadQuery / OpenCASCADE ─► GLB + per-solid metrics
  spec text  ──┘                     │
                                     └─► LLM audit ─► PASS/FAIL + per-check fixes
                                                          │
                          Next.js ─► React Three Fiber ────┘
                                     (failed parts painted #EF4444)
```

1. **Geometry extraction** (`backend/cad_processor.py`) imports the STEP file, walks every
   solid, records its bounding-box extents, volume and distinct cylindrical face diameters
   (so holes, bores and screw shanks are auditable), and re-exports the assembly as GLB
   with each solid named `part_1`, `part_2`, …
   IFC files take the parallel path in `backend/ifc_processor.py`, which adds BIM data —
   IFC class, predefined type, type name, material and flattened property/quantity sets —
   and normalises every length to millimetres whatever unit the file was authored in.
2. **Conformance audit** (`backend/auditor.py`) hands those measurements plus your
   requirements text to an LLM, which returns structured JSON: overall verdict, a summary,
   the failing part ids, and one check object per requirement with an actionable CAD fix
   and an explainable `comment`.
3. **Deterministic clash pre-check** (`backend/clash_detector.py`) runs *before* the LLM and
   compares the bounding box of every component pair. Because it is arithmetic on measured
   numbers rather than inference, it is fully reproducible, and the result is passed into the
   audit as verified fact so interference findings cannot be hallucinated.
4. **Visualisation** (`frontend/src/components/CADViewer.tsx`) loads the GLB and traverses
   the scene graph, repainting every mesh whose name matches a failed `part_id` bright red.
5. **Engine sign-off** (`frontend/src/lib/decisions.ts`) records Accept / Reject / Change
   required plus notes against each finding, persisted to `localStorage`.
6. **Report export** (`frontend/src/components/AuditReport.tsx`) turns the audit plus the
   sign-off into a JSON file and a printable report.

## Prerequisites

| Tool | Version used |
| --- | --- |
| Python | 3.10+ (verified on 3.14) |
| Node.js | 18+ (verified on 22) |
| LLM API key | DeepSeek or any OpenAI-compatible endpoint |

## Quick start

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The service starts on `http://127.0.0.1:8000`. Confirm it is up:

```bash
curl http://127.0.0.1:8000/api/health
# {"status":"ok","static_dir":"...","models_dir_writable":true}
```

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`.

> Run **both** services. The frontend calls the backend for every audit; the page will
> render but the submit button will fail with a clear "could not reach the audit service"
> message if uvicorn is not running.

### 3. Try it

Generate a sample model, then upload it through the UI:

```bash
cd backend
python make_sample.py sample_bracket.step
```

Specification text that produces a **FAIL** (the plate is modelled at 120 mm, the spec
asks for 145 mm):

```
Base plate must be 145 mm long, 40 mm wide and 10 mm thick.
Mounting post must be 25 mm x 25 mm x 60 mm.
All linear dimensions carry a tolerance of +/- 0.5 mm.
```

Change `145` to `120` and the audit flips to **PASS** with the plate rendered in grey.

## Configuration

LLM settings are read from the repo-root `.env.local` (also works from `backend/.env` or
the ambient environment):

```ini
DEEPSEEK_API_KEY="sk-..."
DEEPSEEK_BASE_URL="https://api.deepseek.com"
DEEPSEEK_MODEL="deepseek-chat"
```

Any OpenAI-compatible provider works — set `OPENAI_API_KEY` / `OPENAI_BASE_URL` /
`OPENAI_MODEL` (or the generic `LLM_*`) instead. If **no** key is configured the service
still extracts geometry and returns the model for viewing; the audit degrades gracefully
to an explanatory message rather than failing the request.

The frontend reads `BACKEND_ORIGIN` from `frontend/.env.local` (default
`http://127.0.0.1:8000`) and uses it to proxy `/static/*` and `/api/audit`, so the browser
only ever talks to its own origin.

## API

### `POST /api/audit`

Multipart form:

| Field | Type | Notes |
| --- | --- | --- |
| `step_file` | file | `.step`, `.stp` or `.ifc`, max 100 MB. The extension selects the geometry backend. |
| `requirements` | string | free-text specification |

Returns `200` with:

```json
{
  "model_url": "/static/models/model_<uuid>.glb",
  "cad_metrics": {
    "solid_count": 3,
    "components": [
      {
        "part_id": "part_1",
        "dimensions_mm": { "length_x": 120.0, "width_y": 40.0, "height_z": 10.0 },
        "volume_mm3": 48000.0,
        "cylindrical_diameters_mm": [12.0, 8.0]
      }
    ]
  },
  "clash": {
    "checked_pairs": 3,
    "excluded_parts": [],
    "interferences": [
      {
        "part_a": "part_1",
        "part_b": "part_3",
        "overlap_mm": { "x": 13.0, "y": 12.96, "z": 3.0 },
        "penetration_mm": 3.0
      }
    ],
    "clearances": [],
    "caveat": "Bounding-box test: conservative, not exact. …"
  },
  "audit": {
    "overall_status": "FAIL",
    "summary": "1 part(s) failed dimensional inspection.",
    "failed_parts": ["part_1"],
    "checks": [
      {
        "check_name": "Base plate length must be 145 mm",
        "part_id": "part_1",
        "status": "FAIL",
        "expected": "Expected 145.00 mm (tolerance +/- 0.5 mm)",
        "found": "Found 120.00 mm",
        "fix_instruction": "Increase the base plate length along the X axis by 25.00 mm (from 120.00 mm to 145.00 mm).",
        "comment": "The plate measures 120.00 mm against a required 145.00 mm, 25.00 mm short and well outside the +/- 0.5 mm tolerance. Extend the plate to 145.00 mm; the mounting hole pattern will otherwise not align with the frame."
      }
    ]
  }
}
```

An IFC upload carries additional per-component fields; all are optional and appear only
when the element actually has them:

```json
{
  "part_id": "IfcWall_2",
  "dimensions_mm": { "length_x": 5000.0, "width_y": 200.0, "height_z": 2700.0 },
  "volume_mm3": 2700000000.0,
  "cylindrical_diameters_mm": [],
  "center_mm": { "x": 2500.0, "y": 100.0, "z": 1350.0 },
  "ifc_class": "IfcWall",
  "predefined_type": "LOADBEARING",
  "type_name": "Basic Wall:200mm",
  "material": "Concrete C30/37",
  "properties": {
    "Pset_WallCommon.FireRating": "REI60",
    "Pset_WallCommon.IsExternal": true,
    "Qto_WallBaseQuantities.Width": 0.2
  }
}
```

`properties` values are passed through exactly as the IFC file stores them, so a
quantity like `Qto_WallBaseQuantities.Width` may be in the file's own unit rather
than millimetres — `0.2` above is metres for a 200 mm wall. `dimensions_mm`,
`volume_mm3` and `center_mm` are always millimetres, converted from the kernel's
SI-metre output, whatever unit the file was authored in.

`comment` is always present on every check, PASS or FAIL: `auditor.py` synthesises a
fallback from the expected/found values if the model omits it. `cylindrical_diameters_mm`
is always empty for IFC input — IFC products arrive as triangulated meshes with no
analytic surface data, so bore and hole diameters are not auditable from an IFC file.

Error responses are always `{"detail": "..."}` with an engineer-readable message:

| Status | Cause |
| --- | --- |
| `400` | Wrong file extension, or the uploaded file is empty |
| `413` | File exceeds the 100 MB limit |
| `422` | The CAD/IFC file could not be parsed, or contains no solids |
| `500` | Unexpected geometry failure |

### Part identifiers

`part_id` / `target_part` and every entry of `failed_parts` is always one of the measured
solid ids (`part_1`, `part_2`, …) or the literal `assembly`, meaning "the model as a
whole". The audit is not trusted to get this right: `auditor.py` re-maps any placeholder
(`"unknown"`, `"n/a"`, `""`, `null`) and any id that was never measured (`part_7`) to
`assembly`, so the UI can never render a broken label. The frontend renders `assembly` as
**Assembly** and counts only real `part_N` ids as highlighted components.

### `GET /api/health`

Liveness probe; also reports whether the static model directory is writable.

### `GET /static/models/<file>.glb`

Serves generated models. Also reachable through the frontend origin, which is what the
viewer actually uses.

## Project layout

```
backend/
  main.py            FastAPI app: CORS, /static mount, POST /api/audit
  cad_processor.py   STEP -> solids + metrics + GLB, with error handling
  ifc_processor.py   IFC -> solids + metrics + BIM properties + GLB
  clash_detector.py  deterministic bounding-box interference pre-check
  auditor.py         LLM conformance audit and response normalisation
  make_sample.py     generates a demo STEP file
  tests/             pytest suite over the committed fixtures
  static/models/     generated GLB output (auto-created)
frontend/
  src/app/page.tsx               dashboard: upload, spec, viewer, checklist, sign-off, export
  src/app/api/audit/route.ts     server-side proxy to the backend
  src/app/globals.css            theme + the @media print rules behind PDF export
  src/components/CADViewer.tsx   React Three Fiber viewer, red highlighting, visibility
  src/components/ModelTree.tsx   component list with hide / isolate controls
  src/components/AuditReport.tsx printable report, rendered only for printing
  src/lib/decisions.ts           sign-off storage, keying and reconciliation
  src/lib/report.ts              report view-model + JSON export
  src/types/audit.ts             shared response and sign-off types
```

## Notes and limitations

- **Part identity is positional.** Solids are numbered `part_1`, `part_2`, … in the order
  OpenCASCADE returns them, and the same numbering appears in the GLB node names. The **Model
  Tree groups components but does not reconstruct a hierarchy** — the data is a flat list, and
  STEP ids carry no parent/child relationship, so IFC grouping by `ifc_class` is a grouping
  rather than a true assembly tree.
- **Only bounding boxes, volume and cylindrical diameters are measured.** Hole and bore
  *diameters* are auditable for STEP, but their positions, depths and counts are not — nor are
  threads, surface finishes, GD&T tolerances or material callouts. A part can pass every
  check while being wrong in ways these metrics cannot see.
- **Cylindrical diameters are per-file, not per-solid.** A STEP carries no reliable per-solid
  attribution for its cylinders, so every component reports the same list of distinct
  diameters found anywhere in the file. An assembly whose parts must be judged separately will
  get the wrong diameters attributed to each.
- **IFC diameters are not measurable at all.** IFC geometry arrives triangulated with no
  analytic surfaces, so `cylindrical_diameters_mm` is always empty for IFC input and a hole or
  pipe diameter requirement is *not verifiable* from an IFC file. The audit reports that as a
  PASS with an explanation rather than a failure, because absent data is not evidence of
  non-conformance. The report shows `not measurable` rather than an empty column.
- **The clash test is a bounding-box approximation, and conservative.** It never misses a
  collision between two boxes, but a rotated part has an axis-aligned box much larger than the
  part itself, so it can report a false interference — two scissor parts 0.10 mm apart are
  almost certainly not in contact. Clashes *inside* a single solid (a bore breaking into a
  wall) are invisible. Every reported clash carries a `caveat` saying so, in the API, the UI
  and the exported report.
- **The dimensional verdict is advisory.** It is an LLM's reading of a numeric summary, not a
  validated inspection, and it is not reproducible run to run. The clash pre-check is the only
  fully deterministic part of the verdict. Review findings before acting on them.
- **Sign-off is per-browser and per-audit.** Decisions live in `localStorage` keyed by check
  identity, so they survive a reload but not a different machine, and re-running the same
  model re-attaches them. A reload discards the audit itself — only the sign-off is kept.
- **Generated GLBs are never cleaned up.** Every audit writes a new file into
  `backend/static/models/`. Delete them periodically, or mount that path to a tmpfs.
- **No persistence or auth.** One request in, one verdict out.

## Tests

```bash
cd backend
python -m pytest tests -v
```

The suite drives the two committed fixtures through both geometry processors and asserts exact
dimensions, volumes, watertightness and clash results, plus the clash detector's own edge cases
(touching faces, zero-extent boxes, excluded parts). It exists because the IFC path previously
had three defects that all failed *silently* — 1000× small dimensions, volumes pinned to 0, and
non-watertight meshes — none of which raised, logged, or showed up in the UI.
