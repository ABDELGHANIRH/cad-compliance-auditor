"""
Generate a small multi-solid STEP file for exercising the auditor.

The default model is deliberately half-compliant: the base plate comes out
120 mm when a 145 mm spec would call for it to fail, which makes it easy to
demonstrate both the PASS and FAIL paths and the red highlighting in the viewer.

    python make_sample.py                 # writes sample_bracket.step
    python make_sample.py out.step 145    # custom path and plate length
"""

from __future__ import annotations

import sys
import warnings

warnings.filterwarnings("ignore", category=FutureWarning)

import cadquery as cq


def build(plate_length: float = 120.0) -> cq.Assembly:
    base_plate = cq.Workplane("XY").box(plate_length, 40, 10)
    mounting_post = cq.Workplane("XY").box(25, 25, 60).translate((0, 0, 35))
    boss = cq.Workplane("XY").circle(8).extrude(12).translate((0, 0, -6))

    assembly = cq.Assembly(name="sample_bracket")
    assembly.add(base_plate, name="base_plate", color=cq.Color(0.6, 0.6, 0.6))
    assembly.add(mounting_post, name="mounting_post", color=cq.Color(0.6, 0.6, 0.6))
    assembly.add(boss, name="boss", color=cq.Color(0.6, 0.6, 0.6))
    return assembly


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "sample_bracket.step"
    plate_length = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0

    build(plate_length).save(out_path)
    print(f"Wrote {out_path} (base plate {plate_length:g} mm long, 3 solids)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
