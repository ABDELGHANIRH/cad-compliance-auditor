# Project Plan — Fix false findings, rewrite the comments, and rebuild the viewer UI

**Status: IMPLEMENTED and verified.** 44 backend tests pass, `npx tsc --noEmit`
is clean, `next build` succeeds, and both audit paths were driven end-to-end in
a real browser. See §7 for what changed against this plan and why.

**Two root causes were found during implementation that this plan did not
predict**, both larger than the ones it did. They are recorded in §7.1 and
§7.2 — the containment rule matters more than the threshold the plan was built
around.

---

## 1. What you asked for

Reading your message and the four screenshots together, there are four separate
complaints:

| # | Your words | What it actually is |
| --- | --- | --- |
| 1 | "the program point out to places where there is no problems" | The **bounding-box** clash test reports interference between parts that merely have overlapping **boxes**. On a pipe skid, boxes overlap almost everywhere the pipes are routed near each other. 21 findings on the demo model, nearly all "overlap by 5.00 mm". |
| 2 | "the errors comments are not understandable, and vague no one can understand them" | The comment text is **better than you think, but you never see it**. `FindingCard` collapses the two labelled sentences into one unlabelled paragraph, and the all-caps `Problem & Impact` / `Action` chip labels are stripped. What remains reads as a wall of prose. |
| 3 | "still there is comments shows up the 3d viewer, that are not necessary" | Two things: (a) **every** finding renders a floating callout card in the 3D scene, so 21 cards fight over one model's worth of pixels — the cluster in `Screenshot 2026-10-03 173718.png`; (b) the `MODEL 08:42` gizmo badge, the `FINDING` tooltip card, and the axis gizmo. |
| 4 | "iwant the program to be like how-it-should-be.png and fully functional" | A **specific layout**: findings panel on the **left** with a `Findings / Severity` tab strip, `Team Chat` on the **right**, a floating viewer toolbar, and in-scene badges that are compact pills with leader lines and a red ring at the defect point. |

**One important correction up front.** In `how-it-should-be.png` the model itself
is a rendered, shaded facility with a base slab and a perspective grid — that is a
design mockup, and I cannot turn an untextured GLB into that. What I *can* and
*will* match from that image is the **interface**: panel positions, the tab strip,
the severity presentation, the chat panel, the toolbar, and the callout anatomy.
I have listed exactly what I am and am not taking from the image in §3.

---

## 2. Root causes, so you can judge whether the fix is right

### 2.1 "It points at places where there is no problem"

The chain, in `backend/clash_detector.py` → `backend/auditor.py` →
`frontend/src/components/CADViewer.tsx`:

1. Every component is reduced to an **axis-aligned bounding box**
   (`_box()`), which for a rotated or diagonal pipe is much bigger than the pipe.
2. Anything above `_EPSILON_MM = 1e-6` mm counts as an interference. There is
   **no minimum meaningful overlap** — a 0.01 mm box graze becomes a `FAIL`.
3. `_clash_findings()` in `auditor.py` then **manufactures a `FAIL` card for every
   single detected pair**, unconditionally, with `comment` text claiming
   *"they cannot both be installed as drawn"*. That sentence is asserting more
   than an AABB test can prove — which the module's own docstring admits.
4. The viewer draws a red pulsing ring **and** a full callout card at the centre
   of that box overlap — a point in mid-air where no solid feature necessarily is.

So the program is doing exactly what it was written to do; the *claim* it makes is
too strong for the *method* it uses. That is the bug.

### 2.2 Why the comments read as vague

The backend actually writes good text. `_clash_findings()` produces:

```
**Problem & Impact:** A_Process_Line_DN80 and B_Vessel_T-101 occupy the same
space. The two parts overlap by 5.00 mm, so they cannot both be installed as
drawn and one of them has to move.

**Action:** Piping team must move A_Process_Line_DN80 clear of B_Vessel_T-101,
or shift the mounting so the two parts no longer share space.
```

Then `FindingCard.tsx` → `findingSummary()` throws the labels away, joins the
sentences into one paragraph, and in the process produces a **run-on sentence**
(`...has to move. Piping team must move...` reads as one blurb). `ReviewRow`
exists and is documented as the labelled renderer — but `findingSummary` bypasses
it. That is why it reads as an undifferentiated wall.

### 2.3 Which comment text is genuinely bad and must be rewritten

Three places, all in `_clash_findings()`:

- The **mirror pair**. Detection compares every pair, so `A vs B` and `B vs A` can
  both be emitted, and the wording never distinguishes the view direction.
- The **"5.00 mm"** number. It is the smallest box overlap on one axis. It is not
  a distance a pipefitter can act on, and presenting it as `Measured: 5.00 mm`
  invites an argument about the number instead of the problem.
- The **"piping team must"** imperative, which is issued even for a graze that
  may be nothing at all.

### 2.4 The unnecessary 3D overlay

`beacons` is built **one per check** (`CADViewer.tsx:2812`) and `AnchorBeacon`
renders an `AlertRing` + sphere + `DefectCallout` for each. With 21 checks that is
21 cards, 21 rings, 21 leader lines. The code already contains a long comment
acknowledging this and papering over it by collapsing all but the active card to a
chip — the pile is still visible in your screenshot. There is also a `MODEL 08:42`
`<Html>` badge and a `FINDING` tooltip.

---

## 3. What I will take from `how-it-should-be.png` — and what I will not

### Taken from the image

| Image element | Where it lands |
| --- | --- |
| Findings panel docked **left**, full height, sitting under the header | `page.tsx` — move the docked inspector from `right-3 ... top-3` to the left edge. Same component, mirrored. |
| Header reads `Audit Status: FAIL – 3 Findings` | `page.tsx` header — status pill becomes that string. |
| Tab strip `Findings | Severity` under the panel title | `ReviewStream` — add the tab strip; see §4.4 for what `Severity` shows. |
| Card anatomy: severity word with icon, title, plain sentence, then `Component / Affected by / Measurement` label-value rows | `FindingCard` — restore labelled rows (labels already exist in the backend payload). |
| Cards carry colour-coded left borders — **red** for CRITICAL, **amber** for WARNING | `FindingCard` — border tone from the derived severity. |
| Right rail **`Team Chat`** with author name, role, timestamp, message bubbles, and an `AI Chat` composer with a `Clear` link | New `frontend/src/components/TeamChat.tsx` on the right. See §4.5 — **this is the one place I need a decision from you.** |
| Floating viewer toolbar, centred above the canvas | `CADViewer` — lift the existing controls into one centred pill. |
| In-scene callout: small `!` pill + title + one-line detail + **leader line** back to a red circle at the defect | `CADViewer` — this is the *only* form a scene callout takes after this change. |
| Red pulsing ring at the defect point | Already implemented (`AlertRing`); keep. |

### Deliberately NOT taken from the image

I want these called out explicitly so you can veto them:

1. **The photorealistic shaded model, base slab and perspective floor.** The image
   is a rendered facility; our viewer shows whatever the uploaded GLB contains. I
   will **not** fake a baseplate or a backdrop. I will keep the existing grid and
   keep the ghosting behaviour, and I will confirm the model reads as a solid
   assembly rather than a washed-out wireframe.
2. **The `Discipline: Engineering ⌄` chip.** Our app has Discipline A / B / Federated
   Overlay, which is a real toggle. I will keep ours; renaming it to match a mockup
   would remove a working control.
3. **The R3F `<Environment>` HDRI.** Adding an HDRI preset changes material
   response on every model and is a rendering-pipeline change, not a UI fix. I will
   only do it if you want it — see §6, question 2.

---

## 4. The plan

Ordered so that the accuracy fix lands before the UI is rebuilt on top of it.

### 4.1 Backend — stop reporting things that are not problems

**`backend/clash_detector.py`**

- Add a significance threshold, `MIN_REPORTABLE_OVERLAP_MM = 2.0`, and apply it
  **on the smallest axis overlap**, not just on `> epsilon`. A pair whose weakest
  axis overlap is below the threshold is demoted out of `interferences`.
- Keep a new `graze_mm` band so nothing is silently discarded: pairs between
  `_EPSILON_MM` and the threshold land in a new `"grazes"` list.
- Record the threshold in the returned caveat so the API, the export and the LLM
  all state what was and was not reported.

**`backend/auditor.py`**

- `_clash_findings()`: only synthesise a `FAIL` for pairs at or above the
  threshold. Pairs in the graze band become **advisory** checks (`status: "PASS"`),
  exactly as `clearances` are handled today — the pattern already exists.
- Rewrite the interference comment. New wording, no imperative, no false claim,
  no raw box number presented as a measurement:

  > **Problem & Impact:** *A_Process_Line_DN80 and B_Vessel_T-101 have
  > overlapping outlines, which means these two parts are likely to be built in
  > the same place. The check measures overall outlines, not the exact shape, so
  > a curved or angled part can overlap on paper without touching on site.*
  >
  > **Action:** *Check the space between A_Process_Line_DN80 and B_Vessel_T-101 on
  > the drawing. If the outlines really do cross, move one of them at least
  > 50.01 mm away from the other. If they clear each other on the drawing, no
  > change is needed.*

- De-duplicate mirror pairs (`A vs B` and `B vs A`) in `_clash_findings` by
  keying on the unordered pair before appending, so one interference yields one
  card.
- Extend the existing jargon scrubber (`_scrub` / `_JARGON`) with the geometric
  terms a reviewer cannot act on: *bounding box, AABB, axis-aligned, penetration,
  frame, datum, local origin, conservative*.

### 4.2 Frontend — make the card readable again

**`frontend/src/components/FindingCard.tsx`**

- Replace the `findingSummary()` paragraph with the **labelled rows** the backend
  already sends: `Problem & Impact` and `Action`, each rendered by the existing
  `ReviewRow` component. Title case the chip labels (`Problem & Impact`, not
  `PROBLEM & IMPACT`) so they read as labels and not as shouting.
- Keep `MetricRow` (the `Target: … | Measured: …` line) — it is already good and
  is part of the image's card anatomy.
- Colour-code the card's left border from the derived severity: **red** for a
  fail, **amber** for an advisory. This is taken straight from the image.
- Restore the `Component` row, which the image shows and the current card omits.

**`frontend/src/lib/review.ts`**

- Add `severityOf(check)` returning `'critical' | 'warning' | 'advisory' | 'ok'`,
  derived from `status` plus whether the finding came from the deterministic
  clash pre-check. Add a `FindingSeverity` type to `types/audit.ts`.
- **Do not** change `parsePlainReview` — its bullet format is load-bearing and
  the three-bullet legacy shape must keep parsing.

### 4.3 Frontend — stop the 3D scene from being buried

**`frontend/src/components/CADViewer.tsx`**

- **Only the active finding gets a callout card.** Every other finding gets a
  compact numbered pill — a badge on the geometry, with the leader line and the
  pulsing ring, but **no prose**. This is exactly the image's anatomy
  (`!` + title + one line) applied to one card at a time instead of twenty-one.
- Cap the drawn pills so a 21-finding audit cannot repopulate the pile: beyond a
  threshold (I suggest 12), show pills only in the current camera view or on the
  selected parts, and say so in the legend.
- **Remove** the `MODEL 08:42` `<Html>` gizmo badge.
- **Remove** the `FINDING` in-scene tooltip card.
- Keep: the red pulsing `AlertRing` at the defect point, the leader line, the
  sphere anchor.
- Lift the viewer toolbar into a single centred floating pill above the canvas,
  matching the image.

### 4.4 Frontend — panel layout

**`frontend/src/app/page.tsx`**

- Move the docked inspector from the right edge to the **left edge**, below the
  header, matching the image. Keep the reopen handle behaviour.
- Header: status pill becomes `Audit Status: FAIL – 3 Findings`.
- Reserve the right rail for the chat panel (§4.5).

**`frontend/src/components/ReviewStream.tsx`**

- Add the `Findings | Severity` tab strip.
- **`Severity` is a roll-up, not a second list of the same 21 cards.** I am making
  a judgement call here: dumping all 21 findings again under a second tab is the
  redundancy you are complaining about. Under `Severity` I will show one line per
  affected **part**, with its worst severity and a count, clicking through to the
  findings on it. **If you want the literal reading — all findings re-listed,
  sorted by severity — say so and I will do that instead.**

### 4.5 The `Team Chat` panel — needs your decision

The image shows a working team chat with named people (`Sarah (Project Lead)`,
`Ben (Structural Engineer)`), timestamps, and an AI Chat composer.

**There is nothing behind this in the app today.** There is no server, no
database, no accounts, and `about-the project.md` states plainly: *"No persistence
and no auth."* `LiveDiscussion.tsx` exists, but it stores comments in
`localStorage` — per browser, per machine. Two people on two laptops cannot see
each other's messages.

So I can build one of three things, and I will not pick silently:

| Option | What it gives you | What it costs |
| --- | --- | --- |
| **A. Local chat panel** (my default) | A real `Team Chat` panel in the right position, wired to the **existing** `LiveDiscussion` store. Works, persists to `localStorage`, honest about being single-browser. **No fake people, no fake timestamps.** | Does not look as busy as the mockup. |
| **B. Seeded demo chat** | Looks exactly like the image on first load, with the sample names and times. | **Fabricated.** It invents colleagues and messages that no one sent. I will not do this unless you explicitly ask, and even then I would label it on screen as sample data. |
| **C. Real multi-user chat** | Actually works between people. | Needs a backend store, identities and auth — a separate project, and it contradicts the stated design (*"no persistence, no auth"*). |

**My recommendation is A.** It gives you the layout you want without inventing
people.

### 4.6 Verification

- `cd backend && python -m pytest tests -v` — the suite asserts exact clash
  results on both fixtures, so the threshold change must be reflected in it
  (`backend/tests/test_geometry_pipeline.py`).
- `cd frontend && npx tsc --noEmit`.
- Re-run the `skid_plant.ifc + sample_skid.ifc` audit and confirm the finding
  count drops to only the pairs above the threshold, that no card says "5.00 mm"
  as a measurement, and that the viewport shows one full callout plus pills.
- Screenshot the result and put it beside `how-it-should-be.png`.

---

## 5. Files I expect to touch

| File | Change |
| --- | --- |
| `backend/clash_detector.py` | Significance threshold, `grazes` band, caveat |
| `backend/auditor.py` | Fail only above threshold, rewrite clash comment, de-dupe mirror pairs, extend jargon scrub |
| `backend/tests/test_geometry_pipeline.py` | Update expectations for the new threshold |
| `frontend/src/components/FindingCard.tsx` | Labelled rows, severity border, `Component` row |
| `frontend/src/lib/review.ts` | `severityOf` |
| `frontend/src/types/audit.ts` | `FindingSeverity` type |
| `frontend/src/components/CADViewer.tsx` | Active-only card, pill cap, remove `MODEL` badge and `FINDING` tooltip, centred toolbar |
| `frontend/src/app/page.tsx` | Panel to the left, right rail for chat, header status text |
| `frontend/src/components/ReviewStream.tsx` | `Findings / Severity` tab strip |
| `frontend/src/components/TeamChat.tsx` | **New** — only if you pick A or C in §4.5 |

---

## 6. What I need from you before I start

1. **§4.5 — which chat option?** A (local, real, my recommendation), B (seeded,
   fabricated — I do not want to do this), or C (real multi-user, much bigger).
2. **§3 — do you want the HDRI environment lighting** to make the model read more
   like the rendered image? It changes every model's appearance. I default to **no**.
3. **§4.4 — the `Severity` tab.** Roll-up per part (my default) or a re-listed,
   sorted copy of every finding?
4. **§4.1 — the threshold.** I have proposed **2.0 mm** as the smallest overlap
   worth calling a problem. Too strict, too loose?

If you approve the plan as written, I will take my defaults on 1–4 (A, no HDRI,
roll-up, 2.0 mm) and start with the backend, since the UI is being rebuilt on top
of the numbers it produces.

---

## 7. What shipped, and where it diverged from the plan

### 7.1 The threshold was necessary but nowhere near sufficient

The plan proposed `MIN_REPORTABLE_OVERLAP_MM = 2.0` as *the* fix. Measured
against your real fixtures, it barely helped:

| | before | threshold only | + containment |
| --- | --- | --- | --- |
| Findings on `skid_plant.ifc` + `sample_skid.ifc` | 21 | 16 | **9** |
| Before your eyes, from the identical 21-card pile | | | **11 total, 9 failing** |

The threshold removed **zero** of the false positives, because they were not
grazes. They were instances of a structural rack — one `IfcMember` measuring
**3680 × 2080 × 2400 mm** — whose bounding box **encloses the entire skid**. Every
pump, vessel and pipe run sits inside it, so the box test reported the rack as
"overlapping" each of them by up to **559 mm**. No mm threshold can separate that
from a real clash, because the number is larger than any genuine clash on the
same model.

**The fix is `_is_contained()`: enclosure AND no protrusion.** A part mounted
within a frame is enclosed by it on every axis; a part that clashes by passing
*through* must emerge on the other side. Two earlier attempts failed and are
worth recording, because both look reasonable:

- **Volume ratio** — the scissor's pin sits inside a blade's box that is **32×**
  its volume, so no volume threshold separates them.
- **Overlap ratio alone** — the pin is 100% inside the blade on X and Y, so the
  ratio reads a perfect 1.0.

Only protrusion separates them. This is now pinned by
`test_a_part_passing_through_another_is_still_a_clash` and
`test_real_fixture_rack_containment_is_excluded`.

### 7.2 The program contradicted itself

Not in the plan, and arguably worse than the false positives. On `test_scissor.step`
the model wrote a check named "Parts must not overlap", measured 3.00 mm, and
marked it **PASS** — while the synthesised finding beside it carried the same
3.00 mm as **FAIL**. Two cards, one measurement, opposite verdicts.

`_normalise` now forces a PASS to FAIL when a check reads as a clash **and quotes
the measured penetration depth**. Two broader rules were written first and both
were wrong — they flipped a legitimate "Minimum clearance between parts must be
100 mm" check. The narrowing is the point, and
`test_a_clash_worded_check_quoting_a_different_number_is_untouched` exists to keep
it narrow.

### 7.3 A silent-drop bug in the API schema

Pydantic **drops** fields it does not declare. `grazes` and `containments` were
computed correctly in the detector and then vanished between `main.py` and the
client, so the frontend saw `containments: null` on a model that had seven of
them. Found only by comparing the direct detector output against the live HTTP
response. `ClashResult` in `main.py` now declares every band, with a comment
saying why the declaration is load-bearing.

### 7.4 The viewer was rendering dark-room materials on a white page

The federated workbench had **no stage backdrop**, while the single-model path
did. The materials are emissive cyan tuned for a dark plant interior, so over
`page.tsx`'s pale grey the model came out a washed-out wireframe — the
"not fully functional" impression. The backdrop is now on both paths.

### 7.5 Decisions you confirmed

All four taken as instructed: **Option A** for chat (a real panel over the
existing `localStorage` store, labelled on screen *"Shared between the tabs open
on this machine. Not sent anywhere."* — no fabricated colleagues or timestamps);
**no HDRI**; **severity roll-up per part**; **2.0 mm** threshold.

### 7.6 Two things to look at

1. **`Local_PLC_Panel_CP01` is reported as clashing with the rack.** It is bolted
   to the outside of the frame and protrudes 135 mm through the box on Y — 70%
   enclosed, 30% out. The rule needs 80%, so it reports. It is genuinely
   indistinguishable, from boxes alone, from the scissor pin passing through the
   blade, and reporting is the safe direction. Pinned by
   `test_a_part_mounted_through_the_frame_wall_is_conservatively_reported`, which
   documents it as a known limitation rather than asserting it away. **Tell me if
   you would rather it were excluded** — it is one constant.

2. **The model sits small in the viewport.** Framing works and the geometry is
   legible, but the opening camera is more generous than the reference image's.
   Tightening it is a one-line change to the rig's distance if you want it.

### 7.7 Verified

- `python -m pytest tests -q` — **44 passed** (was 30; 14 added, two of which
  caught real over-corrections in my own fix).
- `npx tsc --noEmit` — clean.
- `npx next build` — compiled successfully.
- Both paths driven in Chromium: federated (`skid_plant.ifc` + `sample_skid.ifc`,
  9 findings, 7 containments excluded) and single-model (`test_scissor.step`,
  3 findings, real clash caught, contradiction corrected).
