# About the Project — CAD Compliance Auditor

An automated conformance checker for 3D building and mechanical models. An engineer
uploads a CAD/BIM file plus a written specification; the tool measures the geometry,
runs a deterministic clash check, asks an LLM to judge the model against the spec, and
returns a reviewable, signable, exportable inspection report — with the problem areas
highlighted in an interactive 3D viewer.

The analogy that shapes every design decision in this repo: **a code inspector who
cannot read drawings.** Instead of opening the model, you hand them a table of
measurements and the specification, and they write up what fails.

---

## 1. What it does, in one picture

```
  .step / .ifc ──┐
                 ├─► FastAPI ─► geometry kernel ─► GLB + per-solid metrics
  spec text  ────┘                    │
                                      ├─► deterministic clash pre-check (AABB)
                                      └─► LLM audit ─► PASS/FAIL + per-check fix
                                                           │
                             Next.js ─► React Three Fiber ─┘
                                        (defect beacons, federated split view)
```

One request in, one verdict out. No persistence, no auth, no database.

---

## 2. Function inventory

### Backend

| File | Function | What it does |
| --- | --- | --- |
| `backend/main.py` | HTTP surface | FastAPI app, CORS, `/static` mount, `POST /api/audit`, `GET /api/health`. Validates, stores, dispatches, federates, cleans up. |
| `backend/cad_processor.py` | STEP geometry | `.step`/`.stp` via trimesh → **cascadio** (packaged OpenCASCADE). Per-solid bbox extents, volume, cylindrical diameters → GLB. |
| `backend/ifc_processor.py` | IFC/BIM geometry | `.ifc` via **ifcopenshell**. Same metrics **plus** IFC class, predefined type, type name, material, flattened psets/qtos. Normalises all lengths to mm. |
| `backend/clash_detector.py` | Interference pre-check | Deterministic AABB overlap between every component pair. Runs **before** the LLM and is passed to it as verified fact. |
| `backend/auditor.py` | LLM audit + normalisation | Builds the prompt, calls the model, then **rebuilds the answer** rather than trusting it: part-id canonicalisation, clash-finding synthesis, comment assembly, jargon scrubbing. |
| `backend/make_sample.py` | Demo generator | Writes a sample STEP bracket (base plate modelled at 120 mm) used by the README walkthrough. |

### Frontend

| File | Function | What it does |
| --- | --- | --- |
| `src/app/page.tsx` | Dashboard / orchestrator | Intake (two drop slots), spec entry, presets, telemetry, viewer, findings, sign-off, export, cross-tab messaging. ~2300 lines. |
| `src/app/api/audit/route.ts` | Same-origin proxy | Forwards the multipart form to FastAPI server-to-server. Keeps the browser same-origin and bypasses CORS preflight for large uploads. |
| `src/components/CADViewer.tsx` | 3D viewer | React Three Fiber scene: ghosting, defect beacons, view presets, gizmo, hide/isolate, camera focus, federated split view. ~3100 lines — the largest file in the repo. |
| `src/components/ModelTree.tsx` | Component list | Parts with hide / isolate controls, grouped by discipline on a federated run. |
| `src/components/ReviewStream.tsx` | Findings feed | Categorised, assignable findings. |
| `src/components/FindingCard.tsx` | Single finding | Renders one check, its bullets, and its sign-off controls. |
| `src/components/LiveDiscussion.tsx` | Threaded comments | Discussion attached to a finding. |
| `src/components/ReviewerSettings.tsx` | Reviewer identity | Who is signing off. |
| `src/lib/decisions.ts` | Sign-off storage | Accept / Reject / Change-required, keyed by check identity, persisted to `localStorage`. |
| `src/lib/review.ts` | Pure translation | Backend finding → review-card shape. Parses the labelled bullet format. |
| `src/lib/report.ts` | Report view-model | Builds the printable report and the JSON export. |
| `src/types/audit.ts` | Shared contract | Response and sign-off types, discipline keys, default reviewer. |

### Fixtures and support

| File | Purpose |
| --- | --- |
| `test_scissor.step` | Mechanical assembly fixture (angled blades — the conservative-AABB test case). |
| `sample_skid.ifc`, `skid_plant.ifc` | BIM fixtures; the riser bore is modelled at 90 mm so a 100 mm requirement fails while the DN32 branch conforms. |
| `make_sample_ifc.py`, `ifc-maker.py` | IFC generators. |
| `backend/tests/test_geometry_pipeline.py` | pytest suite over both committed fixtures. |
| `config.yaml` | LiteLLM routing of all model requests to DeepSeek. |

---

## 3. How it works — A to Z

### A — Intake

The dashboard presents **two drop slots**:

- **Slot A** — mechanical / piping (required)
- **Slot B** — electrical / structural (optional)

Filling both makes the request **federated**: two disciplines of one assembly. There is
a free-text spec area and one-click presets, each pairing specification text with the
model it was written against so a click produces a runnable audit rather than a spec
with nothing to check it against.

### B — Transport

The browser never talks to FastAPI directly. `src/app/api/audit/route.ts` is a
same-origin Next.js proxy that forwards the form server-to-server. Consequences: the
page renders identically on `localhost:3000` and `127.0.0.1:3000`, and large STEP
uploads are not constrained by CORS preflight. `maxDuration = 300` gives the geometry
import room to finish.

### C — Backend entry

`POST /api/audit` in `backend/main.py`:

1. **Store uploads.** 1 MB chunks to a temp file, enforcing the 100 MB limit (`413`),
   rejecting unknown extensions (`400`) and empty files (`400`). Windows-specific care:
   `mkstemp`'s file descriptor must be closed before OpenCASCADE touches the file, and
   the temp suffix must match the real format because cascadio re-sniffs the extension
   internally.
2. **Dispatch** on extension to the STEP or IFC processor. Domain errors become `422`
   with an engineer-readable message; anything else becomes `500`.
3. **Clean up** in a `finally`, with a short retry loop — Windows can hold the handle
   for a few milliseconds after the read, and a leaked temp file must never turn a
   successful audit into an error response.
4. **Clash pre-check**, wrapped in its own try/except that logs and continues with an
   empty result rather than failing the whole request.

### D — Geometry extraction: STEP

`cad_processor.py` reads the file, walks every solid, and records bounding-box extents,
volume and distinct cylindrical face diameters (so holes, bores and screw shanks are
auditable), then re-exports the assembly as GLB with solids named `part_1`, `part_2`, …

Two behaviours are load-bearing and documented in the module because both have bitten
this project:

- **cascadio emits glTF, and glTF is in metres.** A millimetre STEP comes back ÷1000, so
  every dimension is scaled ×1000 and every volume ×10⁹ — otherwise the audit compares
  metres against a millimetre spec and fails correct geometry.
- **`include_brep=True` does not work on cascadio 0.1.1** — no `extras.brep_faces` is
  emitted, so cylinder diameters are regex-parsed out of the **STEP text itself**.

`requirements.txt` pins this deliberately: *"Do NOT replace this with cadquery/OCP"*
(no Python 3.14 wheel), and notes that the pip `gmsh` wheel **cannot read STEP at all**
despite being installed.

### E — Geometry extraction: IFC

`ifc_processor.py` handles IFC2X3/IFC4 and mixed solid types (CSG, B-Rep, extrusions,
swept disks). It returns the same metric shape as STEP, **plus** BIM data: IFC class,
predefined type, type name, material, and flattened property/quantity sets such as
`"Pset_WallCommon.FireRating": "REI60"`, capped at 60 properties per component. Spatial
elements are excluded and every length is normalised to millimetres.

The two processors returning an **identical shape** is the design keystone — everything
downstream is format-agnostic.

### F — Federation

With both slots filled, `_merge_discipline_metrics()` re-keys each discipline's parts
into one namespace (`A_part_1`, `B_part_1`). This matters: both processors number from
`part_1`, and since the audit, the clash check and the viewer all key off `part_id`, a
collision would make a finding unfixable — the viewer would highlight whichever mesh
happened to match first. Each solid is also tagged with its `discipline`, and each
discipline is exported to its **own GLB** so the viewer can toggle them independently.

### G — Deterministic clash detection

`clash_detector.py` reduces every component to an axis-aligned bounding box. Two boxes
overlap when their extents overlap on all three axes at once, and the penetration depth
is the smallest of the three overlaps — how far you would have to move one part to
separate them. Pairs that do not touch but sit closer than the clearance threshold are
reported separately as near-misses.

It is **the only fully reproducible part of the verdict**. No coordinate transform is
needed: `center_mm` and `dimensions_mm` are computed together, before the Z-up→Y-up
rotation and before the GLB scale, so the later transform is a single shared linear map
that cancels out of a relative test.

It is also honest about being **conservative, not exact**: a rotated part has a box much
larger than the part, so it can be reported as clashing when nothing is touching; and a
clash *inside* one solid (a bore breaking into a wall) is invisible. Every result carries
that caveat, surfaced in the API, the UI and the export.

### H — The LLM audit

`auditor.py` sends the metrics JSON, the specification, a scope note and the clash result
to an OpenAI-compatible endpoint (DeepSeek by default) at `temperature: 0`, requesting
JSON.

The **scope note** tells the model up front whether any solid carried BIM properties.
Without it the model tends to treat a geometry-only STEP model as a BIM model whose
properties are all missing, and reports conformance failures for data that was never in
scope.

Every failure path — no solids, no spec, no API key, malformed JSON, network error —
returns a graceful `_empty_audit()` that **still carries the measured clash findings**,
so a real measured interference never vanishes behind an unrelated failure.

### I — Not trusting the model

This is the intellectual core of the project. The model authors the `checks` array, but
three post-processing passes refuse to take its word for it:

1. **Part-id canonicalisation** (`_canonical_part_id`) — any placeholder (`"unknown"`,
   `"n/a"`, `""`, `null`) and any id that was never measured (`part_7`) is re-mapped to
   the literal `assembly`. The UI can therefore never render a broken label.
2. **Clash synthesis** (`_clash_findings`) — guarantees a card per *detected* pair. A
   model that omits or paraphrases an interference cannot leave a measured overlap
   unreported. De-duplication keys on the part pair, subset either way.
3. **Comment assembly and jargon scrubbing** (`_bullet_comment`, `_scrub`, `_JARGON`) —
   `_normalise` builds the comment itself rather than trusting the model's prose,
   because the reader is an on-site **Quality Inspector, not a CAD specialist**: someone
   who cannot open the model and will act on the wording. The static jargon map is the
   last line of defence, since a prompt instruction alone cannot guarantee a phrase never
   appears.

DeepSeek supports `json_object` mode rather than strict `json_schema` mode, so
`_normalise` — not the API contract — is what actually guarantees the shape reaching the
frontend.

### J — Response

`AuditResponse` carries `model_url`, `cad_metrics`, `clash`, `audit`, and `models`. The
`models` field appears only for a federated run, so the pre-federation response shape is
unchanged for every existing caller.

### K — The 3D viewer

`CADViewer.tsx` is essentially an application of its own. The most interesting decision
is a **reversal of the original design**, documented in the code: the flagged solid is
*no longer painted red*. Filling a whole pipe run red to report a clash at one point
overstates the finding and buries the surrounding geometry a reviewer needs to see.

Instead:

- Non-flagged parts render mid-grey, or at 60% opacity as **ghosts** while findings are
  on screen. Ghosts also set `depthWrite = false` — transparency alone is not enough,
  because a faded surface still writes depth and would occlude the very part the finding
  is about.
- The red (`#EF4444`) lives on a **localised beacon at the defect coordinate**, which is
  also what the legend keys, so the swatch and the thing it names stay the same size.

Also present: view presets, gizmo, grid, orbit/pan modes, per-part hide/isolate, camera
focus requests, and a **federated split view** — discipline A isolated, discipline B
isolated, and an overlaid coordination window where both models are placed on a shared
origin so their relative geometry is meaningful.

### L — Review, sign-off and collaboration

Findings are categorised and assigned to reviewers, signed off as Accept / Reject /
Change-required, and discussed in threads. Decisions persist to `localStorage` keyed by
check identity, so they survive a reload and re-attach when the same model is re-audited.

`page.tsx` also opens a **`BroadcastChannel`** so a second browser tab can observe the
same audit. The receiving tab treats the channel as untrusted input — every field is
validated before it reaches state, and there is an echo guard, because one tab can hold
more than one channel after a remount or under React strict mode.

### M — Export

`AuditReport.tsx` renders off-screen and is revealed only by the `@media print` rules in
`globals.css` — that is the PDF path. `report.ts` builds the view-model and the JSON
record. Both carry the sign-off alongside the audit.

### N — Tests

`backend/tests/test_geometry_pipeline.py` drives the committed fixtures through both
geometry processors, asserting exact dimensions, volumes, watertightness and clash
results, plus the clash detector's own edge cases (touching faces, zero-extent boxes,
excluded parts, conservative behaviour under rotation).

The suite exists for a specific reason, stated in the README: the IFC path previously had
**three defects that all failed silently** — 1000× small dimensions, volumes pinned to
zero, and non-watertight meshes. None of them raised, logged, or showed up in the UI.

---

## 4. API reference

### `POST /api/audit`

| Field | Type | Notes |
| --- | --- | --- |
| `step_file` | file | `.step`, `.stp` or `.ifc`, max 100 MB. Extension selects the geometry backend. |
| `requirements` | string | Free-text specification. |
| `discipline_b_file` | file? | Optional second discipline; its presence federates the audit. |

Returns `200` with `model_url`, `cad_metrics`, `clash`, `audit` and (federated only)
`models`.

Errors are always `{"detail": "..."}` with an engineer-readable message:

| Status | Cause |
| --- | --- |
| `400` | Wrong file extension, or empty upload |
| `413` | File exceeds the 100 MB limit |
| `422` | The CAD/IFC file could not be parsed, or contains no solids |
| `500` | Unexpected geometry failure |

### Other endpoints

- `GET /api/health` — liveness probe; also reports whether the static model directory is
  writable.
- `GET /static/models/<file>.glb` — serves generated models.

---

## 5. Known limitations

The project is unusually candid about these, and they should be taken at face value.

- **Part identity is positional.** Solids are numbered `part_1`, `part_2`, … in
  OpenCASCADE's return order. The model tree groups components but does **not**
  reconstruct a hierarchy — the data is a flat list and STEP ids carry no parent/child
  relationship.
- **Only bounding boxes, volume and cylinder diameters are measured.** No hole positions,
  depths, counts, threads, surface finishes, GD&T tolerances or material callouts. A part
  can pass every check while being wrong in ways these metrics cannot see.
- **Cylinder diameters are per-file, not per-solid.** A STEP carries no reliable per-solid
  attribution for its cylinders, so every component reports the same list of distinct
  diameters found anywhere in the file.
- **IFC diameters are not measurable at all.** IFC geometry arrives triangulated with no
  analytic surfaces, so a hole or pipe diameter requirement is *not verifiable* from an
  IFC file. The audit reports that as a PASS with an explanation rather than a failure,
  because absent data is not evidence of non-conformance.
- **The clash test is a bounding-box approximation and is conservative.** It never misses
  a collision between two boxes, but a rotated part has an axis-aligned box much larger
  than the part itself, so it can report a false interference. Clashes *inside* a single
  solid are invisible.
- **The dimensional verdict is advisory.** It is an LLM's reading of a numeric summary,
  not a validated inspection, and it is not reproducible run to run. The clash pre-check
  is the only fully deterministic part of the verdict.
- **Sign-off is per-browser and per-audit.** Decisions live in `localStorage`. A reload
  discards the audit itself; only the sign-off is kept.
- **Generated GLBs are never cleaned up.** Every audit writes a new file into
  `backend/static/models/`.
- **No persistence and no auth.** One request in, one verdict out.

---

## 6. Technology and configuration

| Layer | Stack |
| --- | --- |
| Backend | Python 3.10+ (verified on 3.14), FastAPI, uvicorn, pydantic |
| STEP geometry | trimesh + **cascadio** (OpenCASCADE). *Not* CadQuery/OCP — no 3.14 wheel |
| IFC geometry | ifcopenshell |
| LLM | Any OpenAI-compatible endpoint; DeepSeek by default |
| Frontend | Next.js 15, React 19, TypeScript, Tailwind |
| 3D | three.js, @react-three/fiber, @react-three/drei |
| Tests | pytest |

LLM settings come from the repo-root `.env.local` (also `backend/.env` or the ambient
environment): `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`. The generic
`OPENAI_*` or `LLM_*` names work too. If **no** key is configured the service still
extracts geometry and returns the model for viewing; the audit degrades to an explanatory
message rather than failing the request.

The frontend reads `BACKEND_ORIGIN` from `frontend/.env.local` (default
`http://127.0.0.1:8000`).

### Running it

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev
```

Then open `http://localhost:3000`. **Both services must run** — the page renders without
the backend, but submitting fails with a clear "could not reach the audit service"
message.

To try it, generate the demo bracket and give it a specification that fails:

```bash
cd backend
python make_sample.py sample_bracket.step
```

```
Base plate must be 145 mm long, 40 mm wide and 10 mm thick.
Mounting post must be 25 mm x 25 mm x 60 mm.
All linear dimensions carry a tolerance of +/- 0.5 mm.
```

Change `145` to `120` and the audit flips to **PASS**.

### Tests

```bash
cd backend
python -m pytest tests -v
```

---

## 7. The through-line

One principle shows up at every layer: **measure what you can measure, and be explicit
about what you inferred.**

The deterministic pre-check exists to anchor the verdict. The post-processing passes
exist to stop the model inventing or dropping findings. The caveats ship inside the API
response. The UI distinguishes a measured clash from an advisory dimension verdict. The
docs name the failure modes instead of hiding them.

The architecture is a hedge against trusting a language model with an engineering
decision — while still using one to do the thing a measurement table cannot: read a
specification and explain what it means for the person standing on site.
