"""
Regression tests for the geometry pipeline and clash detection.

These pin the exact values that were verified by hand against the two committed
fixtures. They exist because the IFC path had three bugs that all failed
*silently* - wrong dimensions, zero volumes, non-watertight meshes - and none of
them raised, logged a warning, or showed up in the UI. Only an assertion on a
known-good number catches that class of defect.

Run from the repo root or from backend/:
    python -m pytest backend/tests -v
"""

from __future__ import annotations

import os
import sys

import pytest

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_DIR = os.path.dirname(BACKEND_DIR)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import auditor  # noqa: E402
import cad_processor  # noqa: E402
import clash_detector  # noqa: E402
import ifc_processor  # noqa: E402

SCISSOR_STEP = os.path.join(ROOT_DIR, "test_scissor.step")
SKID_IFC = os.path.join(ROOT_DIR, "sample_skid.ifc")
# The larger fixture, and the only one carrying a structural frame. Kept
# separate from SKID_IFC because the containment rule can only be tested
# against a model that actually has an enclosing member.
SKID_PLANT_IFC = os.path.join(ROOT_DIR, "skid_plant.ifc")

pytestmark = pytest.mark.skipif(
    not (os.path.exists(SCISSOR_STEP) and os.path.exists(SKID_IFC)),
    reason="fixture files not present",
)


@pytest.fixture(scope="module")
def scissor(tmp_path_factory):
    out = tmp_path_factory.mktemp("step") / "scissor.glb"
    return cad_processor.process_step_geometry(SCISSOR_STEP, str(out)), out


@pytest.fixture(scope="module")
def skid(tmp_path_factory):
    out = tmp_path_factory.mktemp("ifc") / "skid.glb"
    return ifc_processor.process_ifc(SKID_IFC, str(out)), out


def _tmp_glb(name):
    """A throwaway GLB path for a test that only needs the metrics."""
    import tempfile

    return os.path.join(tempfile.mkdtemp(prefix=f"cad_{name}_"), f"{name}.glb")


def _by_id(metrics, part_id):
    for component in metrics["components"]:
        if component["part_id"] == part_id:
            return component
    raise AssertionError(f"{part_id} not measured; got {[c['part_id'] for c in metrics['components']]}")


def _dims(component):
    d = component["dimensions_mm"]
    return (d["length_x"], d["width_y"], d["height_z"])


# --------------------------------------------------------------------------
# STEP path
# --------------------------------------------------------------------------


def test_step_solid_count(scissor):
    metrics, _ = scissor
    assert metrics["solid_count"] == 3


def test_step_dimensions_are_millimetres(scissor):
    """The scissor blade is ~194 mm. If the metre->mm scaling regresses this
    comes back as 0.194 and every dimensional audit fails."""
    metrics, _ = scissor
    assert _dims(_by_id(metrics, "part_1")) == pytest.approx((194.39, 89.46, 3.0), abs=0.05)


def test_step_cylindrical_diameters(scissor):
    """Diameters parsed from the STEP text by radius*2, largest first."""
    metrics, _ = scissor
    assert _by_id(metrics, "part_1")["cylindrical_diameters_mm"] == pytest.approx(
        [20.0, 13.0, 7.6, 4.0], abs=0.01
    )


def test_step_glb_is_written_and_y_up(scissor):
    _, out = scissor
    assert out.exists() and out.stat().st_size > 0
    import numpy as np
    import trimesh

    scene = trimesh.load(str(out))
    extents = np.asarray(scene.bounds[1]) - np.asarray(scene.bounds[0])
    # Z-up -> Y-up means the blade lies along X and the assembly's height ends
    # up on Y. Measured in the source Z-up frame the extents are
    # [194.4, 120.0, 9.7]; after the rotation the last two swap, so a *missing*
    # rotation would leave 120.0 on Y and 9.7 on Z, and this catches that.
    assert extents[0] == pytest.approx(194.39, abs=0.1)
    assert extents[1] == pytest.approx(9.7, abs=0.1)
    assert extents[2] == pytest.approx(119.96, abs=0.1)


# --------------------------------------------------------------------------
# IFC path - the three silent-failure regressions
# --------------------------------------------------------------------------


def test_ifc_solid_count(skid):
    metrics, _ = skid
    assert metrics["solid_count"] == 5


def test_ifc_dimensions_are_millimetres(skid):
    """
    B2 regression. ifcopenshell returns SI metres, so the conversion is a fixed
    x1000. Multiplying by `calculate_unit_scale` as well divides by 1000, which
    measured this 220 mm pump as 0.22 mm.
    """
    metrics, _ = skid
    assert _dims(_by_id(metrics, "Booster_Pump_P1")) == pytest.approx((220.0, 300.0, 200.0), abs=0.05)


def test_ifc_volume_is_computed(skid):
    """
    B1 regression. The kernel's `geom.volume` attribute does not exist on
    ifcopenshell 0.8.5, so reading it reported 0.0 for every element.
    """
    metrics, _ = skid
    assert _by_id(metrics, "Booster_Pump_P1")["volume_mm3"] == pytest.approx(13_200_000, rel=1e-3)


def test_ifc_cylinder_volume_is_close_to_analytic(skid):
    """
    The riser is a 90 mm dia x 2400 mm cylinder. A tessellated cylinder is a
    polygonal prism, so its volume is legitimately a little under pi*r^2*h - the
    tolerance below (1.5%) allows for that while still failing hard on the
    original bug, which reported 0.0.

    Volume here comes from the mesh, not the kernel: `geom.volume` does not
    exist on ifcopenshell 0.8.5, so a regression to reading it would drop this
    to 0 and fail.
    """
    import math

    metrics, _ = skid
    expected = math.pi * 45.0**2 * 2400.0
    measured = _by_id(metrics, "Riser_Pipe_Main_01")["volume_mm3"]
    assert measured > 0, "volume regressed to 0 - kernel attribute being read again?"
    assert measured == pytest.approx(expected, rel=0.015)
    assert measured < expected, "tessellated prism should not exceed the analytic cylinder"


def test_ifc_meshes_are_watertight(skid):
    """
    B3 regression. Without merging vertices the GLB holds unwelded triangles,
    the surface is open, and the mesh has a degenerate bounding box.
    """
    import numpy as np
    import trimesh

    _, out = skid
    scene = trimesh.load(str(out))
    extents = np.asarray(scene.bounds[1]) - np.asarray(scene.bounds[0])
    assert (extents > 1.0).all(), f"GLB bounding box collapsed: {extents}"
    for name, geometry in scene.geometry.items():
        assert geometry.is_watertight, f"{name} is not watertight"


def test_ifc_bim_properties_survive(skid):
    """The BIM extraction that justifies the IFC path at all."""
    metrics, _ = skid
    pump = _by_id(metrics, "Booster_Pump_P1")
    assert pump["ifc_class"] == "IfcEnergyConversionDevice"
    properties = pump.get("properties") or {}
    assert "Pset_PumpCommon.Manufacturer" in properties


def test_ifc_cylindrical_diameters_always_empty(skid):
    """IFC arrives triangulated with no analytic surfaces - documented contract."""
    metrics, _ = skid
    for component in metrics["components"]:
        assert component["cylindrical_diameters_mm"] == []


def test_ifc_excludes_spatial_elements(skid):
    """IfcSite/IfcBuildingStorey are IfcProducts but not auditable solids."""
    metrics, _ = skid
    ids = {c["part_id"] for c in metrics["components"]}
    assert "Commercial_Site" not in ids
    assert not any("BuildingStorey" in i for i in ids)


# --------------------------------------------------------------------------
# Clash detection
# --------------------------------------------------------------------------


def _component(part_id, center, dims, **extra):
    return {
        "part_id": part_id,
        "center_mm": {"x": center[0], "y": center[1], "z": center[2]},
        "dimensions_mm": {"length_x": dims[0], "width_y": dims[1], "height_z": dims[2]},
        **extra,
    }


def test_clash_detects_overlap_and_depth():
    metrics = {"components": [_component("A", (0, 0, 0), (100, 50, 50)), _component("B", (94, 0, 0), (100, 50, 50))]}
    result = clash_detector.detect_clashes(metrics)
    assert len(result["interferences"]) == 1
    found = result["interferences"][0]
    assert {found["part_a"], found["part_b"]} == {"A", "B"}
    assert found["penetration_mm"] == pytest.approx(6.0)
    assert found["overlap_mm"]["x"] == pytest.approx(6.0)


def test_clash_touching_faces_are_not_interference():
    """Mating faces meet with zero overlap; that is normal, not a clash."""
    metrics = {"components": [_component("A", (0, 0, 0), (100, 50, 50)), _component("B", (100, 0, 0), (100, 50, 50))]}
    assert clash_detector.detect_clashes(metrics)["interferences"] == []


def test_clash_separated_parts_are_clean():
    metrics = {"components": [_component("A", (0, 0, 0), (100, 50, 50)), _component("B", (102, 0, 0), (100, 50, 50))]}
    assert clash_detector.detect_clashes(metrics)["interferences"] == []


def test_clash_clearance_reports_near_miss():
    metrics = {"components": [_component("A", (0, 0, 0), (100, 50, 50)), _component("B", (102, 0, 0), (100, 50, 50))]}
    clearances = clash_detector.detect_clashes(metrics, clearance_mm=5.0)["clearances"]
    assert len(clearances) == 1 and clearances[0]["gap_mm"] == pytest.approx(2.0)


def test_clash_skips_assembly_and_local_frame():
    metrics = {
        "components": [
            _component("A", (0, 0, 0), (100, 50, 50)),
            _component("assembly", (0, 0, 0), (1, 1, 1)),
            _component("B", (0, 0, 0), (100, 50, 50), local_frame=True),
        ]
    }
    result = clash_detector.detect_clashes(metrics)
    reasons = {e["part_id"]: e["reason"] for e in result["excluded_parts"]}
    assert set(reasons) == {"assembly", "B"}
    assert result["interferences"] == []


def test_clash_ignores_zero_extent_boxes():
    metrics = {"components": [_component("A", (0, 0, 0), (100, 50, 50)), _component("B", (0, 0, 0), (0, 0, 0))]}
    result = clash_detector.detect_clashes(metrics)
    assert result["interferences"] == []
    assert any(e["part_id"] == "B" for e in result["excluded_parts"])


def test_clash_real_fixtures_are_deterministic(scissor, skid):
    """Same input, same result - this is the property the LLM audit lacks."""
    step_metrics, _ = scissor
    ifc_metrics, _ = skid
    for metrics in (step_metrics, ifc_metrics):
        first = clash_detector.detect_clashes(metrics)
        second = clash_detector.detect_clashes(metrics)
        assert first == second
    # The scissor pin genuinely engages both blades.
    ids = {frozenset((i["part_a"], i["part_b"])) for i in clash_detector.detect_clashes(step_metrics)["interferences"]}
    assert frozenset(("part_1", "part_3")) in ids


def test_clash_is_conservative_on_rotation():
    """
    Documents the known false-positive mode rather than pretending it away: a
    rotated part's axis-aligned box can overlap a neighbour when the solid does
    not. This asserts the *behaviour* (it reports), so a future precise
    implementation failing this test is a signal to update the caveat too.
    """
    metrics = {"components": [_component("A", (0, 0, 0), (100, 100, 10)), _component("B", (90, 90, 0), (100, 100, 10))]}
    assert clash_detector.detect_clashes(metrics)["interferences"]


# --------------------------------------------------------------------------
# Clash findings reach the review feed
# --------------------------------------------------------------------------
#
# The clash pre-check is the one fully reproducible measurement in an audit, but
# it is only handed to the model as prompt context - the `checks` array is
# model-authored. These tests cover the pass that guarantees every detected pair
# gets a card, so a model that omits or paraphrases an interference cannot leave
# a measured overlap unreported.


def _interference(part_a="Pump", part_b="Line_A", penetration=31.8):
    return {
        "interferences": [
            {"part_a": part_a, "part_b": part_b, "penetration_mm": penetration}
        ],
        "clearances": [],
    }


def test_clash_finding_names_both_parts_and_their_measurement():
    known = {"Pump", "Line_A"}
    findings = auditor._clash_findings(_interference(), known)

    assert len(findings) == 1
    found = findings[0]
    assert found["status"] == "FAIL"
    assert found["part_id"] == "Pump"
    assert "Pump" in found["check_name"] and "Line_A" in found["check_name"]
    assert "31.80" in found["found"]
    # The card renders these two sentences; a missing one renders as a blank row.
    for label in ("**Problem & Impact:**", "**Action:**"):
        assert label in found["comment"]
    assert "31.80" in found["comment"]


def test_clash_finding_carries_a_concrete_fix():
    findings = auditor._clash_findings(_interference(), {"Pump", "Line_A"})
    fix = findings[0]["fix_instruction"]
    assert "31.80" in fix and "Pump" in fix and "Line_A" in fix


def test_clearance_is_advisory_not_a_failure():
    """The box test is conservative, so a near-miss must not read as a fault."""
    clash = {
        "interferences": [],
        "clearances": [{"part_a": "A", "part_b": "B", "gap_mm": 2.0}],
    }
    findings = auditor._clash_findings(clash, {"A", "B"})

    assert len(findings) == 1
    assert findings[0]["status"] == "PASS"
    # The gap is a metric, so it travels in the badge rather than in the prose.
    assert "2.00" in findings[0]["found"]
    assert "2.00" not in findings[0]["comment"]


def test_clash_findings_empty_without_a_pre_check():
    assert auditor._clash_findings(None) == []
    assert auditor._clash_findings({"interferences": [], "clearances": []}) == []


# --------------------------------------------------------------------------
# The reporting threshold
# --------------------------------------------------------------------------
#
# Bounding boxes are larger than the parts they describe, so two pipes routed
# near each other produce a positive box overlap without touching. Treating any
# overlap at all as a failure filled the finding feed with clashes no engineer
# could act on, which is the defect these tests lock down.


def test_shallow_box_overlap_is_a_graze_not_an_interference():
    metrics = {
        "components": [
            _component("A", (0, 0, 0), (100, 50, 50)),
            _component("B", (99.5, 0, 0), (100, 50, 50)),
        ]
    }
    result = clash_detector.detect_clashes(metrics)

    assert result["interferences"] == []
    assert len(result["grazes"]) == 1
    assert result["grazes"][0]["penetration_mm"] == pytest.approx(0.5)


def test_overlap_at_the_threshold_is_an_interference():
    """The boundary itself, so an off-by-one in the comparison is caught."""
    threshold = clash_detector.MIN_REPORTABLE_OVERLAP_MM
    metrics = {
        "components": [
            _component("A", (0, 0, 0), (100, 50, 50)),
            _component("B", (100 - threshold, 0, 0), (100, 50, 50)),
        ]
    }
    result = clash_detector.detect_clashes(metrics)

    assert len(result["interferences"]) == 1
    assert result["grazes"] == []


def test_graze_reaches_the_feed_as_an_advisory():
    """A graze is reported, but as PASS - it is a pair to look at, not a fault."""
    clash = {
        "interferences": [],
        "grazes": [{"part_a": "A", "part_b": "B", "penetration_mm": 0.5}],
        "min_reportable_overlap_mm": 2.0,
        "clearances": [],
    }
    findings = auditor._clash_findings(clash, {"A", "B"})

    assert len(findings) == 1
    assert findings[0]["status"] == "PASS"
    assert "0.50" in findings[0]["found"]


def test_mirror_pairs_are_reported_once():
    """
    The detector compares every pair, so A-vs-B and B-vs-A can both appear.
    Appending a card for each would show one interference twice, with the part
    names swapped and the reader left to work out they are the same problem.
    """
    clash = {
        "interferences": [
            {"part_a": "A", "part_b": "B", "penetration_mm": 50.0},
            {"part_a": "B", "part_b": "A", "penetration_mm": 50.0},
        ],
        "clearances": [],
    }
    assert len(auditor._clash_findings(clash, {"A", "B"})) == 1


def test_clash_comment_does_not_assert_more_than_was_measured():
    """
    The wording must describe what the check found, not what is true of the
    steel. The old text said the parts "occupy the same space" and "cannot both
    be installed as drawn" - neither of which an axis-aligned box test can
    establish, and both of which made a box artefact read as a collision.
    """
    comment = auditor._clash_findings(_interference(), {"Pump", "Line_A"})[0]["comment"]
    lowered = comment.lower()

    for overclaim in (
        "occupy the same space",
        "cannot both be installed",
        "must move",
    ):
        assert overclaim not in lowered
    # ...and it must say why the reading is uncertain.
    assert "outline" in lowered


def test_clash_scope_note_marks_grazes_as_not_failures():
    """
    The model is given the pre-check as prompt context. If the graze band were
    handed over without that label, the model would write the failures back up
    itself and the threshold would achieve nothing.
    """
    clash = {
        "interferences": [],
        "grazes": [{"part_a": "A", "part_b": "B", "penetration_mm": 0.5}],
        "min_reportable_overlap_mm": 2.0,
        "clearances": [],
        "excluded_parts": [],
        "caveat": "",
    }
    note = auditor._clash_scope_note(clash)

    assert "NOT failures" in note
    assert "A" in note and "B" in note


# --------------------------------------------------------------------------
# Containment: a part mounted inside a frame is not a clash
# --------------------------------------------------------------------------
#
# The defect that produced the most false findings on a real model. A structural
# rack is measured as ONE box that encloses the whole skid, so a box test
# reports it as overlapping every pump, vessel and pipe run it carries - by
# hundreds of millimetres, which is deeper than any genuine clash on the model
# and therefore impossible to filter out with an mm threshold.


def test_part_inside_a_frame_is_containment_not_a_clash():
    """A vessel mounted within a rack: enclosed, does not emerge."""
    metrics = {
        "components": [
            _component("Rack", (0, 0, 0), (4000, 2400, 2400)),
            _component("Vessel", (500, 300, 0), (560, 560, 1400)),
        ]
    }
    result = clash_detector.detect_clashes(metrics)

    assert result["interferences"] == []
    assert len(result["containments"]) == 1
    assert result["containments"][0]["contained"] == "Vessel"


def test_a_part_passing_through_another_is_still_a_clash():
    """
    The scissor fixture in miniature, and the case that defeated two earlier
    versions of this rule. A pin sits inside a blade's footprint and protrudes
    above and below it, because it passes through. That is a real interference
    and must not be filtered out as containment.

    Neither volume nor a bare overlap ratio separates these: the blade's box is
    over 30x the pin's volume, and the pin is wholly within the blade's extent
    on X and Y.
    """
    metrics = {
        "components": [
            _component("Blade", (0, 0, 0), (194, 89, 3)),
            # Spans the blade: below it at z=-1.5 and above it at z=8.2.
            _component("Pin", (0, 0, 3.35), (13, 13, 9.7)),
        ]
    }
    result = clash_detector.detect_clashes(metrics)

    assert len(result["interferences"]) == 1
    assert result["containments"] == []
    assert result["interferences"][0]["penetration_mm"] == pytest.approx(3.0)


def test_real_fixture_rack_containment_is_excluded():
    """
    The measured behaviour on the skid fixture, which is what the fix was
    written for. `Steel_Frame_Rack` is a single IfcMember whose box encloses
    the assembly, so before this rule it was reported as clashing with every
    pump, vessel and pipe run it carries - by up to 559 mm.
    """
    rack_metrics = ifc_processor.process_ifc(SKID_PLANT_IFC, str(_tmp_glb("rack")))
    result = clash_detector.detect_clashes(rack_metrics)

    # The parts that sit wholly within the rack are recognised as mounted.
    contained = {c["contained"] for c in result["containments"]}
    for mounted in ("Vessel_T-101", "Vessel_T-102", "Pump_P-101", "Pump_P-102"):
        assert mounted in contained, f"{mounted} should read as mounted in the rack"

    # ...and none of them is reported as clashing with it.
    rack_clashes = {
        frozenset((i["part_a"], i["part_b"]))
        for i in result["interferences"]
        if "Rack" in i["part_a"] or "Rack" in i["part_b"]
    }
    for mounted in ("Vessel_T-101", "Pump_P-101", "Manifold_Pipe_Blue_DN100"):
        assert frozenset(("Steel_Frame_Rack", mounted)) not in rack_clashes


def test_a_part_mounted_through_the_frame_wall_is_conservatively_reported():
    """
    Documents a case the rule cannot resolve, rather than asserting it away.

    `Local_PLC_Panel_CP01` is bolted to the outside of the rack and protrudes
    through its bounding box on Y. That is indistinguishable, from boxes alone,
    from a part passing through the frame - and the scissor pin proves a part
    passing through is a real clash. The rule therefore reports it.

    Reporting is the safe direction: a prompt to look at a pair costs a
    reviewer a minute, where a swallowed interference costs a rework. If this
    ever starts passing, the rule has been widened too far and the scissor
    fixture is the test to check it against.
    """
    rack_metrics = ifc_processor.process_ifc(SKID_PLANT_IFC, str(_tmp_glb("panel")))
    result = clash_detector.detect_clashes(rack_metrics)

    pair = frozenset(("Steel_Frame_Rack", "Local_PLC_Panel_CP01"))
    reported = {frozenset((i["part_a"], i["part_b"])) for i in result["interferences"]}
    contained = {frozenset((c["part_a"], c["part_b"])) for c in result["containments"]}

    assert pair in reported
    assert pair not in contained


def test_normalise_appends_a_clash_the_model_omitted():
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Base plate length",
                "part_id": "Pump",
                "status": "PASS",
                "problem_impact": "The check found nothing wrong.",
                "action": "No action required.",
            }
        ],
    }
    result = auditor._normalise(raw, {"Pump", "Line_A"}, _interference())

    names = [c["check_name"] for c in result["checks"]]
    assert len(result["checks"]) == 2
    assert any("Line_A" in name for name in names)
    # A measured overlap must fail the audit even though the model passed everything.
    assert result["overall_status"] == "FAIL"
    assert "Pump" in result["failed_parts"]


def test_normalise_corrects_a_model_that_passed_a_measured_clash():
    """
    A measured interference outranks the model's opinion of it.

    Observed on the scissor fixture: the model wrote a check named "Parts must
    not overlap", measured 3.00 mm, and marked it PASS - while the synthesised
    finding for the same pair carried the same 3.00 mm as a FAIL. Two cards
    disagreeing about one measurement tells the reviewer the tool does not know
    what it measured, which costs more trust than either wording being plain.
    """
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Parts must not overlap",
                "part_id": "part_1",
                "status": "PASS",
                "expected": "n/a",
                "found": "3.00 mm",
                "problem_impact": "The outlines were measured.",
                "action": "Nothing to do.",
            }
        ],
    }
    clash = {
        "interferences": [{"part_a": "part_1", "part_b": "part_3", "penetration_mm": 3.0}],
        "clearances": [],
    }
    result = auditor._normalise(raw, {"part_1", "part_3"}, clash)

    # One card, not two - the model's wording wins, and its status is corrected.
    named = [c for c in result["checks"] if c["check_name"] == "Parts must not overlap"]
    assert len(named) == 1
    assert named[0]["status"] == "FAIL"
    assert result["overall_status"] == "FAIL"


def test_normalise_corrects_a_clash_the_model_attributed_to_the_assembly():
    """
    The real shape of the defect, and the case that defeated two earlier fixes.

    The model attributed the clash to `assembly` rather than to a solid, and
    named neither part in its text, so neither pair-key matching nor part-name
    matching could identify the check. What it did do is quote the measured
    penetration of 3.00 mm - and a clash check quoting a measured depth
    alongside a PASS contradicts itself whatever pair it is nominally about.
    """
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Parts must not overlap",
                "part_id": "assembly",
                "status": "PASS",
                "expected": "n/a",
                "found": "3.00 mm",
                "problem_impact": "The outlines were measured.",
                "action": "Nothing to do.",
            }
        ],
    }
    clash = {
        "interferences": [{"part_a": "part_1", "part_b": "part_3", "penetration_mm": 3.0}],
        "clearances": [],
    }
    result = auditor._normalise(raw, {"part_1", "part_2", "part_3"}, clash)

    named = [c for c in result["checks"] if c["check_name"] == "Parts must not overlap"]
    assert named and named[0]["status"] == "FAIL"


def test_normalise_leaves_an_unrelated_pass_alone():
    """The correction must be narrow: a check on another pair keeps its PASS."""
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Bypass line diameter",
                "part_id": "Pump",
                "status": "PASS",
                "expected": "50 mm",
                "found": "50 mm",
                "problem_impact": "Diameter is within tolerance.",
                "action": "No action required.",
            }
        ],
    }
    result = auditor._normalise(raw, {"Pump", "Line_A"}, _interference())

    kept = [c for c in result["checks"] if c["check_name"] == "Bypass line diameter"]
    assert kept and kept[0]["status"] == "PASS"


def test_a_clash_worded_check_quoting_a_different_number_is_untouched():
    """
    The depth rule matches the MEASURED penetration, not any number.

    A clash-worded check reporting some other figure - a specified clearance, a
    diameter - must keep its verdict, or the correction would fail every
    clearance requirement that quotes a value.
    """
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Minimum clearance between parts must be 100 mm",
                "part_id": "Pump",
                "status": "PASS",
                "expected": "100 mm",
                "found": "100 mm",
                "problem_impact": "Clearance is within specification.",
                "action": "No action required.",
            }
        ],
    }
    result = auditor._normalise(raw, {"Pump", "Line_A"}, _interference())

    kept = [
        c for c in result["checks"] if c["check_name"].startswith("Minimum clearance")
    ]
    assert kept and kept[0]["status"] == "PASS"


def test_normalise_prefers_the_models_own_clash_wording():
    """No duplicate card when the model already wrote the pair up."""
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Pump overlaps Line_A",
                "part_id": "Pump",
                "status": "FAIL",
                "problem_impact": "The check found nothing wrong.",
                "action": "No action required.",
            }
        ],
    }
    result = auditor._normalise(raw, {"Pump", "Line_A"}, _interference())

    assert len(result["checks"]) == 1
    assert result["checks"][0]["check_name"] == "Pump overlaps Line_A"


def test_normalise_dedupes_a_paraphrased_clash():
    """
    A model that names neither id verbatim still attributed the clash to one of
    the parts, and appending a synthesised near-duplicate beside its own wording
    would show the reviewer the same interference twice.
    """
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Booster pump overlaps the distribution line",
                "part_id": "Pump",
                "status": "FAIL",
                "comment": "**Status:** The pump overlaps the line by 31.8 mm.",
            }
        ],
    }
    result = auditor._normalise(raw, {"Pump", "Line_A"}, _interference())

    assert len(result["checks"]) == 1


def test_normalise_leaves_a_dimension_check_alone():
    """
    A dimensional failure that merely mentions a neighbour is not a clash
    write-up, and must not suppress the synthesised clash card.
    """
    raw = {
        "summary": "s",
        "checks": [
            {
                "check_name": "Base plate length must be 145 mm",
                "part_id": "Pump",
                "status": "FAIL",
                "expected": "145",
                "found": "120",
                "fix_instruction": "Shorten it so it does not clash with Line_A.",
                "problem_impact": "The check found nothing wrong.",
                "action": "No action required.",
            }
        ],
    }
    result = auditor._normalise(raw, {"Pump", "Line_A"}, _interference())

    assert len(result["checks"]) == 2


def test_empty_audit_still_reports_a_measured_clash():
    """
    A missing API key is not a reason to drop a measurement that was already
    taken in Python.
    """
    result = auditor._empty_audit("no LLM key", auditor._clash_findings(_interference()))

    assert result["overall_status"] == "FAIL"
    assert len(result["checks"]) == 1
    assert result["failed_parts"] == ["Pump"]


def test_empty_audit_without_clash_is_unchanged():
    result = auditor._empty_audit("nothing to do")
    assert result == {
        "overall_status": "PASS",
        "summary": "nothing to do",
        "failed_parts": [],
        "checks": [],
    }
