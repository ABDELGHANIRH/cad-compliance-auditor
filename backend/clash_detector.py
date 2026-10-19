"""
Deterministic geometric clash (interference) detection.

Runs on the measured metrics, before the LLM audit, and produces a result the
model is told to treat as verified fact rather than something to infer. This is
the one part of the verdict that is fully reproducible: the same upload always
yields the same clashes, because it is arithmetic on the numbers the geometry
kernel already returned.

What it does
------------
Every component is reduced to an axis-aligned bounding box (AABB) from its
`center_mm` and `dimensions_mm`. Two boxes overlap when their extents overlap on
all three axes at once; the penetration depth is the smallest of the three
overlaps, i.e. the distance you would have to move one part to separate them.
Pairs that do not overlap but sit closer than the clearance threshold are
reported separately as near-misses.

A reported overlap is then banded by depth, because the method's own error is
larger than zero:

  * `interferences` - overlap at or above `MIN_REPORTABLE_OVERLAP_MM`, and not
    merely one part sitting inside another. Deep enough to be a real problem
    rather than an artefact of boxing a curved part.
  * `grazes` - a positive overlap below that threshold. The boxes touch, but
    only by an amount the approximation itself can produce, so these are listed
    for the reviewer to look at and are NOT failures.
  * `containments` - one box largely enclosing the other. A part mounted within
    a structural frame is the normal case on a skid, and its raw penetration is
    most of the part, so it must be classified before any mm threshold is
    applied. Not failures either.
  * `clearances` - separated, closer than the caller's clearance threshold.

The bands exist because "any overlap at all is a clash" was tried and was wrong
in two independent ways. AABB boxes are larger than the parts they describe, so
a routed pipe skid yields positive overlaps on pairs of pipes that are merely
near each other; and a structural rack's box encloses everything mounted inside
it, so the rack "overlaps" every part of the assembly it carries. The first is
handled by the threshold, the second by the containment ratio. On
`skid_plant.ifc` the containment rule is what removes essentially all of the
false findings.

Frame
-----
Within ONE discipline, no coordinate transformation is needed. `center_mm` and
`dimensions_mm` are computed together, before the Z-up -> Y-up rotation and
before the GLB scale, so they are already internally consistent. The rotation and
scale applied later are a single linear map (rotation then a uniform positive
scale, no translation and no reflection) shared by every component, so it cancels
out of a *relative* test - differences of centres transform exactly like the
centres themselves. Verified numerically against the real processors.

Across TWO disciplines it does NOT cancel, and this is the case that matters for
a federated audit. Each uploaded file carries its own local origin: the skid
model's parts are authored around its own datum, the plant model's around its
own, and nothing in either file states how the two are related in space. The
GLB pipeline handles this for *display* by measuring a combined frame and
applying it to both (see `placeOnFederatedOrigin` in the viewer), but the raw
`center_mm` values this module compares have had no such treatment.

Comparing them anyway is not a near-miss, it is a category error - it overlays
two unrelated datums and reports the result as a penetration. On the demo skid
that produced interferences of 5595 mm and 100 mm between parts that are nowhere
near each other, because one file's box happened to enclose the other's. A
number like that is worse than no number: it is handed to the audit model as
verified fact and reproduced on the finding card as a measurement.

So cross-discipline pairs are excluded, with the reason recorded, for exactly
the same cause `local_frame` already covers: two components whose centres are
expressed in different frames cannot be compared by subtraction.

Honest limitations
------------------
This is AABB, so it is CONSERVATIVE, not exact:

  * Two boxes can overlap while the real solids do not. A rotated part - the
    sample scissor's angled blades, for instance - has a bounding box much larger
    than the part, so it can be reported as clashing when nothing is touching.
    Two scissor parts measured 0.10 mm apart in X are almost certainly not in
    contact.
  * A true clash is never missed between two boxes, but a clash between two
    features *inside* one solid (a bore breaking into a wall) is invisible here,
    because only per-component boxes are compared.
  * Interferences between two *different* disciplines are not reported at all,
    because their frames are not comparable. See the Frame section.

So a reported interference is a prompt to look at the pair, not a verdict. The
`caveat` field below is emitted with the result and repeated to the LLM so this
does not get overstated downstream.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

logger = logging.getLogger(__name__)

# Pairs whose boxes are separated by less than this (mm) are reported as
# near-misses rather than interferences. Mechanical assemblies legitimately have
# mating faces at zero separation, so the default is deliberately 0.0: only
# genuinely touching/overlapping geometry is flagged as an interference, and
# anything else is simply not reported unless a caller asks for clearance work.
DEFAULT_CLEARANCE_MM = 0.0

# Overlap below this (mm) is numerical noise from the 0.05 mm tessellation
# deflection, not a real interference.
_EPSILON_MM = 1e-6

# The smallest box overlap (mm) worth calling an interference.
#
# `_EPSILON_MM` alone is far too permissive, and that was a real defect in this
# project: any box graze at all became a FAIL. The boxes here are axis-aligned
# and therefore *larger than the parts they describe*, so on a routed pipe skid
# two pipes running parallel a few millimetres apart produce a positive overlap
# on every axis purely from the box corners. Reporting those as "occupied the
# same space" is the single largest source of the false findings this module
# produced.
#
# 2 mm is the resolution at which a box overlap stops being attributable to the
# box approximation itself. It is a judgement, not a measurement, and it is
# emitted in the caveat for exactly that reason.
MIN_REPORTABLE_OVERLAP_MM = 2.0

# How much of the smaller box may sit inside the larger one before the pair is
# read as containment rather than a crossing.
#
# This is the fix for the defect that mattered most. On a process skid the
# structural rack is a single IfcMember whose box encloses the whole assembly -
# measured on `skid_plant.ifc` it is 3680 x 2080 x 2400 mm, and every pump,
# vessel and pipe run sits inside it. A box test therefore reports the rack as
# "overlapping" each of them by hundreds of millimetres: 559 mm against a
# vessel, 290 mm against a pump.
#
# No penetration threshold can separate that from a real crossing, because the
# number is larger than any genuine clash on the same model. What distinguishes
# them is shape, not size - see `_is_contained`.
#
# 0.8 rather than 1.0 so that a part sitting mostly inside a frame - mounted
# within it, with a stub protruding - is still recognised as mounted rather than
# clashing. Deliberately conservative in the safe direction: pairs excluded here
# are still reported in `containments`, so nothing measured is lost.
CONTAINMENT_RATIO = 0.8

CAVEAT = (
    "Bounding-box test: conservative, not exact. Rotated parts can report a "
    "false interference because their axis-aligned box is larger than the part. "
    "Treat a reported clash as a pair to inspect, not a confirmed collision."
)

CAVEAT_FEDERATED = (
    CAVEAT
    + " Pairs spanning two disciplines are not compared: each uploaded file has "
    "its own local origin, so their centres are not in a common frame."
)


def _box(component: Dict[str, Any]) -> Optional[tuple]:
    """(min, max) corners in mm for one component, or None if unmeasurable."""
    center = component.get("center_mm")
    dims = component.get("dimensions_mm")
    if not isinstance(center, dict) or not isinstance(dims, dict):
        return None
    try:
        c = np.array(
            [float(center.get("x", 0.0)), float(center.get("y", 0.0)), float(center.get("z", 0.0))],
            dtype=float,
        )
        d = np.array(
            [
                float(dims.get("length_x", 0.0)),
                float(dims.get("width_y", 0.0)),
                float(dims.get("height_z", 0.0)),
            ],
            dtype=float,
        )
    except (TypeError, ValueError):
        return None
    if not np.all(np.isfinite(c)) or not np.all(np.isfinite(d)):
        return None
    # A zero-extent box would overlap nothing meaningfully and would sit exactly
    # on its centre; it carries no geometric information.
    if np.all(d <= 0.0):
        return None
    half = np.maximum(d, 0.0) / 2.0
    return c - half, c + half


def _overlap(a: tuple, b: tuple) -> np.ndarray:
    """Per-axis overlap (mm). Positive on an axis means the extents intersect."""
    return np.minimum(a[1], b[1]) - np.maximum(a[0], b[0])


def _overlap_ratio(a: tuple, b: tuple) -> float:
    """
    How much of the smaller box sits inside the other, on the weakest axis.

    1.0 means the smaller box is entirely within the larger one on that axis;
    0.0 means they barely graze. This is the number that separates the two
    things a box overlap can mean, and the raw penetration in mm cannot:

      * a vessel *inside* a structural rack overlaps by most of the vessel, and
      * a pipe crossing another pipe overlaps by a thin slab of it.

    Both are "an overlap". Only the second is an interference.

    The ratio is taken per axis and the *minimum* returned, because containment
    is a claim about every axis at once: a part is inside a frame only if it is
    within it in X, Y and Z. Two thin plates lying one on top of the other
    overlap by 100% of their shared thickness with no containment at all, and
    only the minimum across axes reports that honestly.
    """
    extents_a = a[1] - a[0]
    extents_b = b[1] - b[0]
    overlap = _overlap(a, b)
    smaller = np.minimum(extents_a, extents_b)
    # A zero-extent axis was already rejected by `_box`, so this cannot divide
    # by zero; guarded anyway so a future caller cannot make it throw.
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(smaller > 0.0, overlap / smaller, 0.0)
    return float(np.min(ratio))


def _is_contained(guest: tuple, host: tuple) -> bool:
    """
    Whether `guest` reads as a part mounted inside `host`, rather than clashing.

    The test is physical, not volumetric, and getting it wrong in either
    direction loses a real finding. Two cases, both in this repo's fixtures:

      * `skid_plant.ifc` - the structural rack's box encloses the vessel it
        carries. The vessel is mounted, and reporting the pair as a clash
        produced a 559 mm "penetration" on a perfectly sound skid.
      * `test_scissor.step` - a 13 mm pivot pin sits centrally inside a blade's
        box, fully within it on every axis, and the pin genuinely passes through
        the blade. That interference is the whole point of the fixture.

    Volume does not separate them: the blade's box is 32x the pin's, because a
    thin plate has a large area and a small volume. What separates them is
    whether the guest *sticks out*. A part mounted within a frame is enclosed by
    it; a part that clashes by passing through must emerge on the other side,
    and on the scissor pair the pin protrudes on Z at both ends - it enters
    below the blade and exits above it.

    So: enclosed on every axis (the ratio), and protruding on none.
    """
    if _overlap_ratio(guest, host) < CONTAINMENT_RATIO:
        return False
    return bool(np.all(guest[0] >= host[0]) and np.all(guest[1] <= host[1]))


def detect_clashes(
    cad_metrics: Dict[str, Any],
    clearance_mm: float = DEFAULT_CLEARANCE_MM,
) -> Dict[str, Any]:
    """
    Find interfering and near-miss component pairs in `cad_metrics`.

    Args:
        cad_metrics: the dict returned by either geometry processor.
        clearance_mm: separation below which a non-overlapping pair is reported
            as a near-miss. 0.0 reports only true interferences.

    Returns:
        {
            "checked_pairs": int,
            "skipped_cross_discipline_pairs": int,
            "excluded_parts": [...],      # ids skipped, with the reason
            "interferences": [
                {"part_a","part_b","overlap_mm":{x,y,z},"penetration_mm"},
                ...
            ],
            "grazes": [...],              # same shape, overlap below the threshold
            "containments": [...],        # one box largely inside the other
            "min_reportable_overlap_mm": float,
            "containment_ratio": float,
            "clearances": [...],          # same shape, only if clearance_mm > 0
            "caveat": str,
        }

    Pure and side-effect free - no I/O, no LLM, no mutation of `cad_metrics`.
    """
    components: Sequence[Dict[str, Any]] = cad_metrics.get("components") or []

    # Parts skipped, so the audit can say what was not checked instead of
    # implying the whole model was cleared.
    excluded: List[Dict[str, str]] = []
    boxes: List[tuple] = []  # (part_id, discipline, min, max)

    # Whether this run holds more than one uploaded file. Nothing downstream is
    # reported differently for it beyond the caveat, but the cross-discipline
    # skip below is otherwise silent and a reviewer is owed the reason.
    disciplines = {
        str(component.get("discipline") or "")
        for component in components
        if component.get("discipline")
    }
    federated = len(disciplines) > 1

    for component in components:
        part_id = str(component.get("part_id") or "")
        if not part_id:
            continue

        # `assembly` is the backend's marker for "the model as a whole", not a
        # solid, so it has no box to compare.
        if part_id == "assembly":
            excluded.append({"part_id": part_id, "reason": "not a solid"})
            continue

        # A component that fell back to the IFC local-coordinate path is in a
        # different frame from every other element, so comparing its centre
        # against theirs would manufacture overlaps near the origin.
        if component.get("local_frame"):
            excluded.append(
                {
                    "part_id": part_id,
                    "reason": "geometry in local coordinates; position not comparable",
                }
            )
            continue

        box = _box(component)
        if box is None:
            excluded.append({"part_id": part_id, "reason": "no usable bounding box"})
            continue
        boxes.append((part_id, str(component.get("discipline") or ""), box[0], box[1]))

    interferences: List[Dict[str, Any]] = []
    grazes: List[Dict[str, Any]] = []
    containments: List[Dict[str, Any]] = []
    clearances: List[Dict[str, Any]] = []
    checked = 0
    skipped_cross_frame = 0

    for i in range(len(boxes)):
        id_a, discipline_a, min_a, max_a = boxes[i]
        for j in range(i + 1, len(boxes)):
            id_b, discipline_b, min_b, max_b = boxes[j]

            # Two files, two unrelated origins - see the Frame section of the
            # module docstring. Subtraction across them yields a difference of
            # datums, not a distance between parts, so the pair is not tested at
            # all rather than tested and reported as an interference.
            if discipline_a != discipline_b:
                skipped_cross_frame += 1
                continue

            checked += 1

            overlap = _overlap((min_a, max_a), (min_b, max_b))
            min_overlap = float(overlap.min())

            if min_overlap > _EPSILON_MM:
                # Positive on all three axes: the boxes genuinely intersect.
                record = {
                    "part_a": id_a,
                    "part_b": id_b,
                    "overlap_mm": {
                        "x": round(float(overlap[0]), 2),
                        "y": round(float(overlap[1]), 2),
                        "z": round(float(overlap[2]), 2),
                    },
                    # The smallest overlap is how far the parts must move
                    # apart along that axis to stop interfering.
                    "penetration_mm": round(min_overlap, 2),
                }

                # Containment first. A box that sits entirely inside another,
                # without emerging from it, does not clash with it - a vessel
                # mounted within a structural rack is the normal case, not a
                # fault, and its raw penetration is most of the vessel. This is
                # the single largest source of false findings on a process skid,
                # and no mm threshold can separate it from a real crossing: the
                # rack's "overlap" with a vessel it carries is hundreds of mm,
                # deeper than any genuine clash on the same model.
                #
                # See `_is_contained` for why the test is enclosure AND
                # protrusion rather than a size or volume comparison.
                #
                # The test is on the RATIO, not on the penetration in mm. An
                # earlier version compared `min_overlap` against a length, which
                # is a dimension mismatch and let deep-but-narrow crossings
                # through unchecked.
                ratio = _overlap_ratio((min_a, max_a), (min_b, max_b))
                volume_a = float((max_a - min_a).prod())
                volume_b = float((max_b - min_b).prod())
                # The smaller of the two is the guest; the larger is the host it
                # would have to be mounted within.
                if volume_a <= volume_b:
                    contained = _is_contained((min_a, max_a), (min_b, max_b))
                else:
                    contained = _is_contained((min_b, max_b), (min_a, max_a))

                if contained:
                    containments.append(
                        {
                            "part_a": id_a,
                            "part_b": id_b,
                            # The part that is the guest of the other.
                            "contained": id_a if volume_a <= volume_b else id_b,
                            "host": id_b if volume_a <= volume_b else id_a,
                            "overlap_ratio": round(ratio, 3),
                            "penetration_mm": round(min_overlap, 2),
                        }
                    )
                    continue

                # A box overlap this shallow is inside the error of the method
                # itself - see MIN_REPORTABLE_OVERLAP_MM. It is kept rather than
                # dropped so nothing measured disappears silently, but it is
                # reported as a graze to look at, not an interference to fix.
                if min_overlap >= MIN_REPORTABLE_OVERLAP_MM:
                    interferences.append(record)
                else:
                    grazes.append(record)
                continue

            if clearance_mm > 0.0:
                # Separated: the gap is the largest negative overlap, negated.
                gap = abs(min_overlap)
                if min_overlap <= _EPSILON_MM and gap < clearance_mm:
                    clearances.append(
                        {
                            "part_a": id_a,
                            "part_b": id_b,
                            "gap_mm": round(gap, 2),
                        }
                    )

    # Worst first: a deep interference matters more than a graze.
    interferences.sort(key=lambda item: item["penetration_mm"], reverse=True)
    grazes.sort(key=lambda item: item["penetration_mm"], reverse=True)
    containments.sort(key=lambda item: item["overlap_ratio"], reverse=True)
    clearances.sort(key=lambda item: item["gap_mm"])

    if interferences:
        logger.info(
            "Clash pre-check: %d interference(s) across %d pair(s)", len(interferences), checked
        )
    if containments:
        logger.info(
            "Clash pre-check: %d pair(s) read as one part mounted within another, "
            "not a clash",
            len(containments),
        )
    if grazes:
        logger.info(
            "Clash pre-check: %d box graze(s) below the %.1f mm reporting threshold",
            len(grazes),
            MIN_REPORTABLE_OVERLAP_MM,
        )
    if skipped_cross_frame:
        logger.info(
            "Clash pre-check: %d cross-discipline pair(s) not compared (separate frames)",
            skipped_cross_frame,
        )

    return {
        "checked_pairs": checked,
        # Pairs the test deliberately did not take. Separate from
        # `excluded_parts`, which names a part that could not be boxed at all -
        # here both parts are fine and it is the *combination* that is untestable.
        "skipped_cross_discipline_pairs": skipped_cross_frame,
        "excluded_parts": excluded,
        "interferences": interferences,
        # Box overlaps too shallow to attribute to anything but the bounding-box
        # approximation. Not failures, and deliberately still reported so the
        # reviewer can see the pairs the test looked at and set aside.
        "grazes": grazes,
        # One box largely enclosing another: a part mounted inside a frame,
        # which is normal, rather than two parts fighting for the same space.
        # Kept for the same reason - excluded from the verdict, not from the
        # record.
        "containments": containments,
        "min_reportable_overlap_mm": MIN_REPORTABLE_OVERLAP_MM,
        "containment_ratio": CONTAINMENT_RATIO,
        "clearances": clearances,
        "caveat": CAVEAT_FEDERATED if federated else CAVEAT,
    }
