"""
LLM diagnostic reporting.

Takes the measured CAD metrics plus the raw engineering requirements text and
asks the LLM to compare the two, producing a structured verdict: which parts
violate the spec, by how much, and what the engineer should change.

Wording
-------
Every finding reaches an on-site quality inspector who is not a CAD specialist.
The model is therefore asked for two short sentences - the physical problem and
its site impact, then the assignment that resolves it - rather than a paragraph,
and the answer is rendered here rather than trusted: `_normalise` assembles the
comment itself and `_scrub` removes geometry jargon that leaks through anyway.
The static `_JARGON` map is the last line of defence, not the first, because a
prompt instruction alone cannot guarantee a phrase never appears.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Set

from dotenv import load_dotenv
from openai import OpenAI

# Look for the repo-root .env.local first, then a backend-local .env, then the
# ambient environment.
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env.local"))
load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = (
    os.getenv("DEEPSEEK_API_KEY")
    or os.getenv("OPENAI_API_KEY")
    or os.getenv("LLM_API_KEY")
)
BASE_URL = (
    os.getenv("DEEPSEEK_BASE_URL")
    or os.getenv("OPENAI_BASE_URL")
    or os.getenv("LLM_BASE_URL")
)
MODEL = (
    os.getenv("DEEPSEEK_MODEL")
    or os.getenv("OPENAI_MODEL")
    or os.getenv("LLM_MODEL")
    or "deepseek-chat"
)
SYSTEM_PROMPT = """You are writing up a quality control inspection for the person
standing on site. That reader is a Quality Inspector, NOT a CAD specialist.
They cannot see the drawing, they cannot open the model, and they will act on
your wording. Every word you write is read by them.

You are given (1) measured geometry from a CAD or BIM model, one entry per
solid, and (2) a textual engineering specification.

Each solid reports:
- bounding-box extents in millimetres (length_x, width_y, height_z)
- volume in cubic millimetres (volume_mm3)
- cylindrical_diameters_mm: the distinct diameters, in millimetres, of every
  cylindrical face on that solid, largest first. Holes, bores and screw shanks
  all appear here. An empty list means the solid has no cylindrical features.

When the model came from an IFC/BIM file, a solid may ALSO report:
- ifc_class: its element type, e.g. "IfcWall", "IfcDoor", "IfcBeam"
- predefined_type: its enumerated subtype, e.g. "LOADBEARING", "EXTERNAL"
- type_name: the name of its type object, if it has one
- material: its associated material, e.g. "Concrete C30/37"
- properties: a flat map of qualified property names to values, drawn from the
  model's property sets and quantity sets. Keys are "<PsetName>.<Property>",
  for example "Pset_WallCommon.FireRating": "REI60",
  "Pset_WallCommon.IsExternal": true, "Qto_WallBaseQuantities.Width": 0.2.

Your job is to determine, check by check, whether the model conforms.

HOW TO WRITE (this is the part the inspector is judged on)
---------------------------------------------------------
For every check you emit, fill in TWO short values. They become the two
sentences of a finding card that a non-engineer reads on site.

- `problem_impact`: ONE sentence. State the PHYSICAL problem first - what is
  actually wrong with the parts, in words an inspector can picture - and then
  what it means for the site. Join the two with "so". Examples:
    "The booster pump housing collides with the branch line, so neither can be
     installed on site without physical interference."
    "The green process pipe diameter does not match the specification schedule,
     so the wrong pipe will be delivered to site."
  For a check that passes, one sentence saying the item is correct as built.
- `action`: ONE sentence assigning the fix to a team, phrased as an instruction
  that can be handed straight to them. Examples:
    "Piping team must shift the branch line clear of the pump body."
    "Confirm correct pipe size with supplier or update model geometry."
  For a check that passes, say that no action is needed.

BANNED IN EVERY PROSE FIELD - the inspector will not understand any of it.
This covers `problem_impact`, `action`, `check_name`, `fix_instruction`,
`comment` and `summary`. `expected` and `found` are the ONLY fields allowed to
carry a number, and only as the short badge described below.

  * No engineering jargon. Use the plain alternative in brackets:
      "triangulated mesh", "analytic cylindrical faces", "analytic surface data"
          [say "this 3D file format" or "this file"]
      "Pset property", "property set", "Qto", "ifc_class"  [say "model property"]
      "bounding box", "AABB", "bounding-box overlap", "bounding-box interference"
          [say "overall size", or "parts overlapping"]
      "deterministic pre-check", "pre-check"  [say "automatic check"]
      "tessellated", "tessellation", "B-Rep", "watertight", "part_id"
          [say "converted", "CAD model", "closed", "part"]
  * No raw coordinate vectors and no axis maths. Never write X, Y or Z
    coordinates, centre points, or a comparison of two vectors. The inspector
    cannot picture "(-120.5, 340.0, 88.2)". Say which parts interfere and by how
    far, in millimetres - never where, in space.
  * No tolerance formulas. Never write "+/- 0.5 mm", "within 1 percent", or any
    other tolerance rule into a prose sentence. A tolerance belongs in `expected`
    when it matters, nowhere else.
  * Never write a raw field name from the JSON (such as
    `cylindrical_diameters_mm`) in prose. Never write an identifier like `part_2`
    where a reader expects a part; write "the part" or name it by what it is.

Rules:
- Treat every dimension in the spec as millimetres unless it says otherwise.
- Compare each stated requirement against the measured value for the part it most
  plausibly refers to. Match parts by their part_id.
- Use a tolerance of +/- 0.5 mm for linear dimensions and +/- 1 percent for
  volumes unless the specification states a tighter or looser tolerance. Keep the
  tolerance OUT of your prose: state it in `expected` only when it matters. Never
  explain a tolerance in `problem_impact` or `action`.
- Emit ONE check object per requirement you can evaluate. If the specification
  contains no quantitative requirement, still emit a single check evaluating
  whether the model is dimensionally plausible, and say so.
- AUDIT CYLINDRICAL FEATURES. Use `cylindrical_diameters_mm` to check hole
  diameters, bore sizes, screw shank diameters and boss diameters: a requirement
  calling for a "6 mm hole" or an "M6 screw" means a diameter of 6.00 mm must
  appear in that list. Only say a cylindrical dimension is not measurable when
  the relevant solid has an empty `cylindrical_diameters_mm`.
- AUDIT BIM PROPERTIES. When a solid reports `properties`, `ifc_class`,
  `predefined_type`, `material` or `type_name`, evaluate the specification
  against them too. Requirements about fire rating, thermal transmittance,
  acoustic rating, load-bearing status, external/internal classification,
  material grade, manufacturer, model reference, or element type are all
  answered by these fields, not by geometry. Match property names
  case-insensitively and ignore the set prefix when the property name alone is
  unambiguous - a spec asking for a "fire rating" is answered by a
  "FireRating" property. Read a value as a number when it looks like one:
  a spec requiring "200 mm wall thickness" matches a recorded width of 0.2 only
  if the model's units make that 200 mm, so check the units before calling it a
  failure.
- If a requirement concerns a model property but no solid reports a `properties`
  map at all, say in `problem_impact` that the model carries no property data,
  and
  mark the check PASS rather than FAIL: absent data is not evidence of
  non-conformance. Do not invent property values.
- Apply the same rule to every measurement this pipeline cannot take. A missing
  measurement is NEVER a failure. In particular:
    * `cylindrical_diameters_mm` is ALWAYS empty for IFC input, because IFC
      geometry arrives as converted meshes carrying no surface definitions. A
      hole, bore or pipe diameter therefore CANNOT be measured from an IFC file,
      so a diameter requirement is NOT verifiable from it - mark the check PASS,
      and put EXACTLY this sentence in `problem_impact`, word for word:
        "Diameter cannot be verified automatically from this 3D format. Please
        verify on the physical part."
      Do not reword it and do not add jargon around it.
    * If a solid reports no `properties`, a property requirement is likewise not
      verifiable - PASS, with a plain explanation.
  Never fail a check on a diameter, bore or hole requirement for an IFC model.
  If the model's `properties` happen to carry a nominal size for the part (for
  example a `NominalDiameter` entry), you may quote it in `expected`/`found` as
  supporting evidence, but it is a nominal designation rather than a measured
  value, it is frequently in different units from the geometry, and it must not
  turn an unmeasurable requirement into a failure. Note the distinction
  explicitly when you use it.
- IDENTIFIERS. `part_id` (also accepted as `target_part`) and every entry of
  `failed_parts` must be exactly one
  of the part_ids supplied in the geometry, or the literal string `assembly`
  when the finding concerns the model as a whole rather than one solid. NEVER
  output "unknown", "n/a", "none", an empty string, or an invented identifier
  such as "part_4" when only three parts were supplied. If you cannot attribute
  a check to a specific solid, use `assembly`.
- `failed_parts` must list the part_id of every part that fails at least one
  check. It must be empty when everything passes. Use `assembly` there only when
  the failing check itself is attributed to `assembly`.
- `overall_status` is FAIL if any check fails, otherwise PASS.
- For every FAIL, `fix_instruction` must be a concrete, actionable edit a
  drafter can perform: what to change, by how much, and in which direction,
  written in the same plain English as `action`. For a model property
  failure, name the property and the value it must take. Never write vague
  advice such as "review the design".
- Every check MUST include a non-empty `check_name` naming the requirement it
  evaluates, in plain English, for example "Base plate length must be 145 mm",
  "Wall fire rating", or "M6 screw hole diameter". Never omit it and never
  leave it blank.
- `expected` and `found` are the inline metric badge: the shortest possible
  reading of the two numbers, VALUE ONLY, with units. Never repeat a label the
  card already prints. Write `expected` as `80.00 mm`, not `Expected 80.00 mm`;
  write `found` as `220.00 mm`, not `Found 220.00 mm`. For a property write
  `REI60` and `REI30`. When a check has nothing to measure or no target to
  compare, leave BOTH blank. The card renders them as
  "Expected: <val> | Actual: <val>" and draws no badge at all when both are
  empty, so a blank field costs nothing and a restated label reads as a stutter.
- Respond with JSON only. No prose, no markdown fences."""
RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "overall_status": {"type": "string", "enum": ["PASS", "FAIL"]},
        "summary": {"type": "string"},
        "failed_parts": {"type": "array", "items": {"type": "string"}},
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "check_name": {"type": "string"},
                    "part_id": {"type": "string"},
                    "status": {"type": "string", "enum": ["PASS", "FAIL"]},
                    "expected": {
                        "type": "string",
                        "description": "Short metric badge value only, with units - e.g. '80.00 mm'. Never prefix it with a label.",
                    },
                    "found": {
                        "type": "string",
                        "description": "Short metric badge value only, with units - e.g. '220.00 mm'. Rendered as 'Actual: <val>'. Never prefix it with a label.",
                    },
                    "fix_instruction": {"type": "string"},
                    "problem_impact": {
                        "type": "string",
                        "description": "ONE sentence: the physical problem with the parts, then what it means on site. No coordinates, no tolerance formulas, no jargon.",
                    },
                    "action": {
                        "type": "string",
                        "description": "ONE sentence: the resolution step, assigned to a team. Empty or 'No action needed.' when the check passes.",
                    },
                    "comment": {
                        "type": "string",
                        "description": "Optional prose explanation. The problem_impact and action fields are preferred.",
                    },
                },
                "required": [
                    "check_name",
                    "part_id",
                    "status",
                    "expected",
                    "found",
                    "fix_instruction",
                    "problem_impact",
                    "action",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["overall_status", "summary", "failed_parts", "checks"],
    "additionalProperties": False,
}


def _empty_audit(
    message: str,
    checks: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    A well-formed result with no LLM findings - used for graceful degradation.

    `checks` carries the deterministic clash findings, which are measured in
    Python and therefore survive a failure of the model call. Reporting "no API
    key is configured" while silently dropping an interference that was actually
    measured would understate the audit; the clash result stands on its own.
    """
    findings = checks or []
    failed = [
        str(check["part_id"])
        for check in findings
        if check.get("status") == "FAIL" and check.get("part_id")
    ]

    return {
        "overall_status": "FAIL" if failed else "PASS",
        "summary": message,
        "failed_parts": failed,
        "checks": findings,
    }


# ---------------------------------------------------------------------------
# Plain-English wording
# ---------------------------------------------------------------------------

# Geometry jargon the SYSTEM_PROMPT bans, mapped to what a reader actually needs
# to know. Longest phrases are matched first (see `_scrub`) so
# "triangulated mesh with no analytic cylindrical faces" resolves as one phrase
# rather than being half-rewritten by the shorter "triangulated mesh" entry.
#
# This exists because a prompt instruction is a request, not a guarantee: the
# model can still echo a phrase it was shown, and it frequently does when the
# specification itself is written in that vocabulary. Rewriting the leak is the
# only way to make the guarantee hold for every response.
_JARGON: Dict[str, str] = {
    "triangulated mesh with no analytic cylindrical faces": "3D file format",
    "triangulated meshes with no analytic surface data": "3D file format",
    "triangulated mesh": "3D mesh",
    "no analytic cylindrical faces": "no measurable hole surfaces",
    "no analytic surface data": "no measurable surface details",
    "analytic cylindrical surfaces": "measurable hole surfaces",
    "cylindrical_diameters_mm": "the hole diameter measurements",
    "bounding box interference": "an overlap between parts",
    "bounding-box interference": "an overlap between parts",
    "bounding box overlap": "an overlap between parts",
    "bounding-box overlap": "an overlap between parts",
    "bounding boxes overlap": "parts overlap",
    "bounding boxes": "part sizes",
    "bounding box": "overall size",
    "bounding-box": "overall size",
    "deterministic pre-check": "automatic check",
    "deterministic precheck": "automatic check",
    "pre-check": "check",
    "pset property": "model property",
    "pset properties": "model properties",
    "property set": "model properties",
    "property sets": "model properties",
    "qto property": "model quantity",
    "@type": "",
    "tol_linear": "",
    "tessellation": "3D conversion",
    "tessellated": "converted",
    "watertight": "closed",
    "ifc_class": "model element type",
    "part_id": "part",
    "nonzero": "non-zero",
    "aabb": "overall size",
    "b-rep": "CAD model",
    "brep": "CAD model",
}

# Whole-word matcher for the keys above, built once. `\b` on both ends, with a
# trailing "s" allowed so "bounding boxes" is caught by "bounding box" - the
# plural is at least as common as the singular in model output.
_JARGON_RE = re.compile(
    "|".join(
        r"\b" + re.escape(term) + r"s?\b"
        for term in sorted(_JARGON, key=len, reverse=True)
    ),
    re.IGNORECASE,
)

# A phrase the model reaches for when a diameter is unmeasurable from a mesh.
# The specification requires one exact sentence in this situation, so the family
# of near-misses is collapsed onto it rather than rewritten word by word (which
# would leave "cannot be verified automatically from this 3D format" reading as a
# syntax error).
#
# Two things keep this from firing on ordinary prose about diameters:
#   * `measurable|verifiable` must appear as a STANDALONE word, so the noun
#     phrase "no analytic cylindrical faces" cannot satisfy it.
#   * The negation must fall inside ONE sentence - `[^.]` spans no full stop. A
#     check reading "The bore measures 90 mm, which does not meet the 100 mm
#     requirement. This diameter is a nominal value." must not be replaced by
#     "cannot be verified", which would invert its meaning.
_DIAMETER_NOTE_RE = re.compile(
    r"\b(?:diameter|bore|hole)\b[^.]{0,120}?"
    r"(?:\bcannot\b|\bcan ?not\b|\bcan't\b|\bunable to\b|\bnot possible to\b|\bis not\b|\bnot\b)"
    r"[^.]{0,80}?"
    r"\b(?:verif\w*|measur\w*|extract\w*|determin\w*|recover\w*|read)\b"
    r"(?:\s+(?:measurable|verifiable))?",
    re.IGNORECASE,
)

DIAMETER_NOT_MEASURABLE = (
    "Diameter cannot be verified automatically from this 3D format. "
    "Please verify on the physical part."
)


def _normalise_ws(text: str) -> str:
    """Lower-case and collapse whitespace, for comparing two phrasings."""
    return re.sub(r"\s+", " ", text or "").strip().lower()


# The sentences that make up DIAMETER_NOT_MEASURABLE, plus the near-misses a
# model writes, used to recognise a note that has already been emitted so its
# tail is not printed twice.
_NOTE_FRAGMENTS = {
    _normalise_ws(part)
    for part in re.split(r"(?<=[.!?])\s+", DIAMETER_NOT_MEASURABLE)
    if part.strip()
} | {
    _normalise_ws("Please verify this on the physical part."),
    _normalise_ws("Please check the physical part."),
    _normalise_ws("Verify on the physical part."),
}


def _scrub(text: str) -> str:
    """
    Replace geometry jargon with plain phrasing.

    Applied to every human-readable field the model returns, including the ones
    the UI renders verbatim (`expected`, `found`, `check_name`) - a banned term
    is as unwelcome in a metric chip as it is in the explanation.

    The diameter substitution is per-sentence, so a comment that mentions an
    unmeasurable diameter in one sentence and something else in the next keeps
    the second sentence rather than being flattened to the one-line note.
    """
    if not text:
        return ""

    # A text that already IS the required note passes straight through. Checked
    # before splitting, because the note is two sentences - each half would
    # otherwise be rewritten separately and the result doubled.
    if _normalise_ws(text) == _normalise_ws(DIAMETER_NOT_MEASURABLE):
        return DIAMETER_NOT_MEASURABLE

    sentences = _split_sentences(text)
    rewritten: List[str] = []
    note_emitted = False
    for sentence in sentences:
        # The second half of an already-emitted note, left behind when the input
        # carried the note plus trailing prose: drop it rather than repeat it.
        if note_emitted and _normalise_ws(sentence) in _NOTE_FRAGMENTS:
            continue
        if _DIAMETER_NOTE_RE.search(sentence):
            if not note_emitted:
                rewritten.append(DIAMETER_NOT_MEASURABLE)
                note_emitted = True
            continue
        rewritten.append(sentence)
    text = " ".join(rewritten)

    scrubbed = _JARGON_RE.sub(lambda match: _JARGON[_canonical_jargon(match.group(0))], text)

    # Substituting a phrase can break the sentence around it ("Overall size is
    # 10 mm" needs no change, but "Bounding boxes are disjoint" -> "Part sizes is
    # disjoint" does). These repair only the exact mismatches the map above can
    # create, so ordinary prose is untouched.
    scrubbed = re.sub(r"\b(sizes|measurements)\s+(is|was)\b", r"\1 are", scrubbed, flags=re.IGNORECASE)
    scrubbed = re.sub(r"\bmeasurements\s+remains\b", "measurements remain", scrubbed, flags=re.IGNORECASE)

    # A noun phrase substituted after "no" makes the article that followed it
    # redundant: "found no bounding box overlap" -> "found no an overlap".
    scrubbed = re.sub(r"\bno an?\s+(?=[a-z])", "no ", scrubbed, flags=re.IGNORECASE)
    # Likewise an article directly before the substituted noun phrase, which
    # already carries its own: "The bounding box interference" -> "The an overlap".
    scrubbed = re.sub(r"\b(the|a|an)\s+an\s+(?=[a-z])", r"\1 ", scrubbed, flags=re.IGNORECASE)
    # "A overlap" -> "An overlap", the one a/an case the map can create.
    scrubbed = re.sub(r"\bA(\s+overlap)\b", r"An\1", scrubbed)
    # "The bounding boxes were compared" -> "The part sizes were compared" reads
    # fine, but a substitution can also leave a definite article before a plural
    # noun that no longer wants one; only strip it when the verb is singular.
    scrubbed = re.sub(r"\bthe\s+(part sizes)\s+(is|was)\b", r"\1 are", scrubbed, flags=re.IGNORECASE)

    scrubbed = re.sub(r"\s{2,}", " ", scrubbed)
    scrubbed = re.sub(r"\s+([,.;:])", r"\1", scrubbed)
    scrubbed = scrubbed.strip()
    if not scrubbed:
        return ""
    # Leave the all-lowercase placeholder alone: "N/a" reads as a typo, and a
    # blank metric is common enough to be worth the special case.
    if scrubbed.lower() in {"n/a", "na", "none"}:
        return scrubbed.lower()
    return scrubbed[:1].upper() + scrubbed[1:]


def _canonical_jargon(matched: str) -> str:
    """Map a matched phrase (possibly pluralised) back to its `_JARGON` key."""
    lowered = matched.lower()
    if lowered in _JARGON:
        return lowered
    if lowered.endswith("s") and lowered[:-1] in _JARGON:
        return lowered[:-1]
    return lowered


def _split_sentences(text: str) -> List[str]:
    """
    Split on sentence-ending punctuation, keeping the punctuation attached.

    A plain `re.split` with a lookbehind is enough here: the input is a short
    model-written comment, not prose needing abbreviation handling, and guessing
    wrong costs nothing worse than a bullet rendered slightly long.
    """
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [part for part in parts if part.strip()]


def _sentence(text: str) -> str:
    """
    Ensure one bullet reads as a sentence: capitalised, with a full stop.

    Only the sentence's first character is upper-cased - never a placeholder
    token elsewhere in it, so "n/a vs 25 mm." does not become "N/a vs 25 mm.".
    """
    cleaned = text.strip()
    if not cleaned:
        return ""
    if cleaned[-1] not in ".!?":
        cleaned += "."
    # A bullet that opens on the "n/a" placeholder keeps it lowercase; "N/a"
    # reads as a typo. This is common - every check the model left a metric
    # blank produces one.
    if cleaned.lower().startswith(("n/a", "na ", "none")):
        return cleaned
    return cleaned[0].upper() + cleaned[1:]


def _bullet(label: str, value: str) -> str:
    """One `**Label:** text` line, or "" when the model supplied no text."""
    cleaned = _sentence(value)
    return f"**{label}:** {cleaned}" if cleaned else ""


def _bullet_comment(problem_impact: str, action: str) -> str:
    """
    Assemble the two-sentence comment the UI renders.

    Problem -> Impact in the first bullet, the resolution step in the second.
    The mid-sentence metrics are not a bullet: the card draws them as an inline
    "Expected: <val> | Actual: <val>" badge above this text.

    Returns "" when the model supplied neither sentence, so the caller can fall
    back to the older single-paragraph `comment` field rather than emitting an
    empty card.
    """
    bullets = [
        _bullet("Problem & Impact", problem_impact),
        _bullet("Action", action),
    ]
    return "\n\n".join(part for part in bullets if part)


# Values a model reaches for when it cannot attribute a finding to a solid.
# The prompt forbids these, but enforcing it here is what actually guarantees
# the UI never renders "unknown".
_UNATTRIBUTED = {"", "unknown", "n/a", "na", "none", "null", "undefined", "-", "assembly"}


def _part_label(part_id: str) -> str:
    """
    Human-readable label for a part identifier.

    Mirrors `partLabel` in the frontend (`frontend/src/types/audit.ts`) so the
    exported report, the printed PDF and the on-screen review card all name a
    part the same way. `assembly` is the backend's marker for "the model as a
    whole" rather than a solid, so it is the one id that is not rendered as-is.
    """
    if not part_id or part_id == "assembly":
        return "Assembly"
    return part_id


def _clash_findings(
    clash: Optional[Dict[str, Any]],
    known_part_ids: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Turn the deterministic clash pre-check into checks the review feed can show.

    The pre-check (`clash_detector.detect_clashes`) is the one fully reproducible
    part of an audit, but it is only ever handed to the model as prompt context -
    the `checks` array is wholly model-authored. A model that summarises an
    interference loosely, or omits it, therefore leaves the reviewer with a dim
    card carrying generic bullet text instead of the measurement that was
    actually taken.

    These synthesised findings close that gap: one check per detected pair,
    naming both parts and carrying the measured penetration or gap. They are
    merged into the model's checks by `_normalise`, which prefers the model's own
    wording when it already covers a pair and only fills the gaps otherwise.

    Three bands, and the difference between them is the whole point:

      * `interferences` FAIL. The overlap is deep enough to be a real problem.
      * `grazes` PASS, advisory. The boxes touch, but by less than the detector's
        reporting threshold, which is inside the error of a bounding-box test.
        Calling one of these a failure is what produced a feed full of
        "overlap by 5.00 mm" findings an engineer could not act on.
      * `clearances` PASS, advisory. The parts do not touch at all.

    Both advisory bands are reported as PASS on purpose. The pre-check is an
    axis-aligned box test, so neither a graze nor a near-miss is evidence of
    non-conformance - presenting either as a failure would overstate what was
    measured.

    Mirror pairs are de-duplicated: the detector compares every pair, so `A
    against B` and `B against A` are both in the result, and appending a card for
    each would report one interference twice with the part names swapped.
    """
    if not clash:
        return []

    findings: List[Dict[str, Any]] = []
    seen_pairs: Set[frozenset] = set()

    def _pair(part_a: str, part_b: str) -> Optional[frozenset]:
        """The unordered pair, or None when this pair already has a card."""
        key = frozenset((part_a, part_b))
        if key in seen_pairs:
            return None
        seen_pairs.add(key)
        return key

    for item in clash.get("interferences") or []:
        part_a = _canonical_part_id(item.get("part_a"), known_part_ids)
        part_b = _canonical_part_id(item.get("part_b"), known_part_ids)
        if part_a == part_b or _pair(part_a, part_b) is None:
            continue

        label_a, label_b = _part_label(part_a), _part_label(part_b)
        penetration = round(float(item.get("penetration_mm") or 0.0), 2)

        findings.append(
            {
                "check_name": f"{label_a} overlaps {label_b}",
                "part_id": part_a,
                "status": "FAIL",
                # NOT "0.00 mm". A clash is not a dimension with a target value -
                # writing one made every clash card show "Target: 0.00 mm", a
                # requirement no drawing states, and gave the reviewer a
                # comparison to argue with instead of a problem to look at. The
                # overlap has no specified value; it has to be zero only in the
                # sense that the parts must not occupy the same space, which the
                # prose says in words.
                "expected": "",
                "found": f"{penetration:.2f} mm",
                "fix_instruction": (
                    f"Separate {label_a} from {label_b} by at least "
                    f"{penetration:.2f} mm, or reposition the mounting so the two "
                    f"parts clear each other."
                ),
                # Written for the inspector on site, who cannot open the model.
                #
                # The wording states what the TEST found ("overlapping outlines")
                # rather than what is true of the steel ("occupy the same space").
                # The earlier version asserted the latter, which is more than a
                # bounding-box check can prove - it is the sentence that made a
                # box artefact read as a confirmed collision. The caveat is in the
                # same breath as the finding so the reviewer is never asked to
                # take the number on trust.
                #
                # "Cannot both be installed as drawn" is gone for the same reason,
                # and the imperative "Piping team must move..." with it: a graze
                # between two box corners does not earn a work instruction.
                "comment": _bullet_comment(
                    f"{label_a} and {label_b} have overlapping outlines, so these "
                    f"two parts are likely to be built in the same place. The "
                    f"check compares overall sizes, not exact shapes, so an angled "
                    f"or curved part can overlap on paper without touching on site.",
                    f"Check the space between {label_a} and {label_b} on the "
                    f"drawing. If their outlines really do cross, move one of them "
                    f"at least {penetration:.2f} mm clear of the other.",
                ),
            }
        )

    for item in clash.get("grazes") or []:
        part_a = _canonical_part_id(item.get("part_a"), known_part_ids)
        part_b = _canonical_part_id(item.get("part_b"), known_part_ids)
        if part_a == part_b or _pair(part_a, part_b) is None:
            continue

        label_a, label_b = _part_label(part_a), _part_label(part_b)
        penetration = round(float(item.get("penetration_mm") or 0.0), 2)
        threshold = round(float(clash.get("min_reportable_overlap_mm") or 0.0), 2)

        findings.append(
            {
                "check_name": f"{label_a} and {label_b} outlines just touch",
                "part_id": part_a,
                # Advisory. The overlap is smaller than the accuracy of the
                # check, so it is a pair to look at, not a defect to fix.
                "status": "PASS",
                "expected": "",
                "found": f"{penetration:.2f} mm",
                "fix_instruction": "",
                "comment": _bullet_comment(
                    f"The outlines of {label_a} and {label_b} meet, but by only "
                    f"{penetration:.2f} mm. The check works from overall sizes "
                    f"rather than exact shapes, so a gap this small is within its "
                    f"margin of error and may not be real.",
                    "No action required. Treat this as a pair to look at if the "
                    "two parts are hard to fit on site.",
                ),
            }
        )

    for item in clash.get("clearances") or []:
        part_a = _canonical_part_id(item.get("part_a"), known_part_ids)
        part_b = _canonical_part_id(item.get("part_b"), known_part_ids)
        if part_a == part_b or _pair(part_a, part_b) is None:
            continue

        label_a, label_b = _part_label(part_a), _part_label(part_b)
        gap = round(float(item.get("gap_mm") or 0.0), 2)

        findings.append(
            {
                "check_name": f"{label_a} is close to {label_b}",
                "part_id": part_a,
                # Advisory, not a failure: the parts do not touch, they are
                # merely closer than the clearance threshold.
                "status": "PASS",
                "expected": "",
                "found": f"{gap:.2f} mm",
                "fix_instruction": "",
                "comment": _bullet_comment(
                    f"{label_a} and {label_b} sit close together without "
                    f"touching. Nothing is fouling today, but there is no room to "
                    f"work between them either.",
                    "No action required unless the specification sets a wider "
                    "minimum clearance.",
                ),
            }
        )

    return findings


# Words that mark a check as being about two parts meeting, as opposed to a
# dimensional or property check on a single part. Used to decide whether a check
# is a candidate for clash de-duplication at all.
_CLASH_WORDS = (
    "overlap",
    "clash",
    "interfer",
    "clearance",
    "too close",
    "collision",
    "collide",
    "penetrat",
)


def _clash_pair_key(
    check: Dict[str, Any],
    known_part_ids: Optional[Set[str]] = None,
) -> Optional[frozenset]:
    """
    A comparable identity for a clash finding, for de-duplication.

    Keyed on the unordered PAIR of part ids, not on the check name. A model
    writes its own phrasing ("Booster pump overlaps the distribution line") that
    will never match a synthesised name, so name matching cannot tell that the
    model already covered a pair - and the same interference would be reported
    twice. Matching on the pair is what lets the model's richer wording win.

    The pair is recovered by finding which known part ids appear in the check's
    name: the synthesised names embed both labels, and a model-authored clash
    name usually names both parts too. Because a name can only *add* ids, this
    errs toward over-matching - and over-matching here is the safe direction,
    since it means preferring a finding that already exists over appending a
    near-duplicate of it.

    Returns None for a check that is plainly not about two parts meeting, so
    ordinary dimensional checks are never candidates.
    """
    part_id = str(check.get("part_id") or "")
    if not part_id:
        return None

    name = str(check.get("check_name") or "")
    comment = str(check.get("comment") or "")
    haystack = f"{name} {comment}".lower()
    if not any(word in haystack for word in _CLASH_WORDS):
        return None

    # The second part is read from the check as a whole, COMMENT INCLUDED. The
    # plain-English bullets raised by `_clash_findings` and by the model both
    # name both parts in prose, even when the check_name paraphrases them
    # ("Booster pump overlaps the distribution line"), so the comment is where
    # the second id is usually recoverable.
    members = {part_id}
    for candidate in known_part_ids or set():
        if candidate and candidate != part_id and candidate.lower() in haystack:
            members.add(candidate)

    # A model that paraphrases both parts ("pump overlaps the line") yields only
    # the primary id. Rather than miss the pair - and report the same
    # interference twice, once in each author's words - a one-element key is
    # matched against the primary part below. Returning it rather than None is
    # what keeps that case de-duplicated.
    return frozenset(members)


def _canonical_part_id(value: Any, known_part_ids: Optional[Set[str]]) -> str:
    """
    Map whatever identifier the model produced onto one the UI can display.

    Returns a measured part_id when the model named one, otherwise `assembly`
    (rendered as "Assembly") -- never a placeholder like "unknown".
    """
    candidate = str(value or "").strip()

    if candidate.lower() in _UNATTRIBUTED:
        return "assembly"

    if known_part_ids is not None:
        # Case-insensitive so "Part_2" still resolves to the measured "part_2".
        by_lower = {pid.lower(): pid for pid in known_part_ids}
        resolved = by_lower.get(candidate.lower())
        if resolved is None:
            logger.warning(
                "Audit referenced unknown part_id %r; reporting it as 'assembly'",
                candidate,
            )
            return "assembly"
        return resolved

    return candidate


def _normalise(
    raw: Dict[str, Any],
    known_part_ids: Optional[Set[str]] = None,
    clash: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Coerce whatever the model returned into the exact contract the UI expects.

    `known_part_ids` is the set of part_ids actually measured from the model. Any
    identifier the model returns that is not in it -- an invented `part_7`, or a
    placeholder like "unknown" -- is rewritten to `assembly`, which the UI renders
    as "Assembly".

    `clash` is the deterministic pre-check. Every pair it detected is guaranteed a
    check in the result (see `_clash_findings`), because that measurement is taken
    in Python and must not depend on the model remembering to write it up.
    """
    checks: List[Dict[str, Any]] = []
    failed: List[str] = []

    for item in raw.get("checks") or []:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status", "")).upper()
        status = "FAIL" if status == "FAIL" else "PASS"
        # `target_part` is the field name the audit brief uses; accept it
        # alongside `part_id` so the identifier rules apply either way.
        raw_id = item.get("part_id") or item.get("target_part")
        part_id = _canonical_part_id(raw_id, known_part_ids)
        # Models drift on this key far more than the others ("name", "check",
        # "requirement"); accept the common aliases so the checklist never
        # renders a row of "Unnamed check".
        name = (
            item.get("check_name")
            or item.get("name")
            or item.get("check")
            or item.get("requirement")
            or item.get("title")
            or item.get("description")
            or item.get("criterion")
        )
        if not name or not str(name).strip():
            # Never render a blank row. Fall back to the requirement text the
            # check was based on, then to the part it belongs to.
            name = item.get("expected") or ("Check on " + part_id)

        expected = _scrub(str(item.get("expected") or "n/a"))
        found = _scrub(str(item.get("found") or "n/a"))
        name = _scrub(str(name))

        # The two sentences ARE the comment. Assembled here rather than trusted
        # from the model, so a response that omits them, or writes a paragraph
        # instead, still reaches the UI in the shape it renders.
        #
        # The three-field shape (`plain_status` / `plain_measurement` /
        # `plain_action`) is still read: a response cached from an older
        # deployment, or one produced by a model that ignored the new brief,
        # carries those names instead, and dropping them would blank the card.
        problem_impact = _scrub(
            str(item.get("problem_impact") or item.get("plain_status") or "")
        )
        action = _scrub(
            str(item.get("action") or item.get("plain_action") or "")
        )
        fix = _scrub(str(item.get("fix_instruction") or ""))

        # Fallback for a response that carried no usable sentences at all: build
        # them from whatever it did send. The card lays out two labelled rows,
        # and leaving one blank there reads as a missing field rather than as
        # "nothing to say", so each is filled from the best source available.
        if not (problem_impact or action):
            prose = str(
                item.get("comment")
                or item.get("reason")
                or item.get("rationale")
                or item.get("explanation")
                or item.get("note")
                or ""
            ).strip()
            # Sentence 1: the explanation if there is one, otherwise the fix,
            # which is the only other sentence that says what is wrong. The
            # placeholder is a genuine last resort, for a model that returned
            # nothing but identifiers and numbers.
            problem_impact = _scrub(prose) or fix or f"Check on {part_id}."
            action = action or fix or "No action required."

        # `plain_measurement` is deliberately not read. The expected/found badge
        # states the numbers and the card renders them itself, so the old
        # measurement sentence is not only redundant but was in metres while
        # `expected`/`found` are in millimetres - two units for one measurement,
        # multiplied by a factor of 1000 and shown on side by side. Comparing
        # the specification directly against `expected`/`found` was dropped with
        # it, for the same reason: the sentence compared a metres value against
        # a millimetres one and could contradict the badge above it.
        comment = _bullet_comment(problem_impact, action)

        checks.append(
            {
                "check_name": name,
                "part_id": part_id,
                "status": status,
                "expected": expected,
                "found": found,
                "fix_instruction": _scrub(str(item.get("fix_instruction") or "")),
                "comment": comment.strip(),
            }
        )
        if status == "FAIL" and part_id not in failed:
            failed.append(part_id)

    # Guarantee a check for every pair the pre-check detected. The model is given
    # the clash result as prompt context, but only the pairs it chose to write up
    # come back in `checks` -- so a model that summarises an interference loosely,
    # or omits it entirely, would leave a measured overlap with no card to review.
    # The model's own wording is preferred where it covers a pair; synthesised
    # findings only fill the gaps.
    covered = {
        key for key in (_clash_pair_key(check, known_part_ids) for check in checks) if key
    }

    def already_covered(key: frozenset) -> bool:
        """
        Whether the model has already written up this pair.

        Both parts named - the ordinary case, and an exact set match.

        Otherwise a strict SUBSET match counts, in either direction. A model that
        paraphrases both parts ("the pump overlaps the line") resolves to just the
        primary id, so its one-element key is a subset of the synthesised pair's
        two-element key. Appending the synthesised card beside the model's own
        wording would show the reviewer the same interference twice, which is the
        duplication this de-duplication exists to prevent.

        Subset rather than one-element-on-one-side so the rule does not depend on
        which of the two keys happens to be the sparse one.
        """
        if key in covered:
            return True
        return any(key < existing or existing < key for existing in covered)

    for finding in _clash_findings(clash, known_part_ids):
        key = _clash_pair_key(finding, known_part_ids)
        if key is not None and already_covered(key):
            continue
        checks.append(finding)
        if key is not None:
            covered.add(key)

    # A measured interference outranks the model's opinion of it.
    #
    # The merge above prefers the model's wording when it covers a pair, on the
    # reasoning that its phrasing is richer than the synthesiser's. What that
    # missed is the model also gets to choose the *status*, and it frequently
    # gets that wrong: on the scissor fixture it wrote a check named "Parts must
    # not overlap", measured 3.00 mm, and marked it PASS - while the synthesised
    # finding beside it carried the same 3.00 mm as a FAIL.
    #
    # Two cards disagreeing about one measurement is worse than either wording
    # being plain, because it tells the reviewer the tool does not know what it
    # measured.
    #
    # The correction is deliberately narrow, and narrower than the first two
    # attempts. Matching on the part pair alone flipped a legitimate "Minimum
    # clearance between parts must be 100 mm" check, because it names a part
    # that happens to appear in a measured pair - a clearance requirement and a
    # clash report are not the same finding, and only the check's own reported
    # value distinguishes them. So the rule is:
    #
    #   a check that reads as being about a clash, AND quotes the measured
    #   penetration depth of a real interference, AND says PASS
    #
    # That is self-contradictory on its face whatever it is nominally about, and
    # it cannot catch a clearance check reporting its own specified value.
    measured_depths = [
        float(item.get("penetration_mm") or 0.0)
        for item in (clash or {}).get("interferences") or []
    ]

    def reports_a_measured_depth(check: Dict[str, Any]) -> bool:
        """
        Whether the check's own `found` value is a measured overlap depth.

        The last resort, and the one that actually holds on the model-authored
        clash checks seen in practice. A model writing "Parts must not overlap"
        with `part_id: "Assembly"` names no part in its text at all, so neither
        key nor text matching can identify it - but it did report the
        measurement, and that number is the penetration the pre-check computed.
        A check quoting a measured penetration alongside a PASS is
        self-contradictory whichever pair it is nominally about.

        Compared as a number to within rounding, not as a string: the check may
        render 3.0 as "3.00 mm" while the pre-check rounded to 3.0.
        """
        if not _normalise_ws(str(check.get("check_name") or "")) or not any(
            word in _normalise_ws(str(check.get("check_name") or "")) for word in _CLASH_WORDS
        ):
            return False
        raw_found = str(check.get("found") or "")
        match = re.search(r"-?\d+(?:\.\d+)?", raw_found)
        if not match:
            return False
        try:
            quoted = float(match.group(0))
        except ValueError:
            return False
        return any(abs(quoted - depth) < 0.005 for depth in measured_depths)

    for check in checks:
        if check.get("status") == "FAIL":
            continue
        if reports_a_measured_depth(check):
            logger.warning(
                "Audit reported %r as PASS despite a measured interference; "
                "correcting it to FAIL",
                check.get("check_name"),
            )
            check["status"] = "FAIL"

    # Any identifier the model listed directly in `failed_parts` is passed
    # through the same filter, so a placeholder there cannot reach the UI either.
    for raw_id in raw.get("failed_parts") or []:
        part_id = _canonical_part_id(raw_id, known_part_ids)
        if part_id not in failed:
            failed.append(part_id)

    # A synthesised clash FAIL is a check like any other, so it must be able to
    # fail the audit even when the model reported nothing wrong. Re-derived from
    # the merged list for that reason.
    for check in checks:
        if check.get("status") == "FAIL":
            part_id = str(check.get("part_id") or "")
            if part_id and part_id not in failed:
                failed.append(part_id)

    # Derive the verdict from the checks rather than trusting the model's own
    # field, so the banner and the checklist can never contradict each other.
    overall = "FAIL" if failed else "PASS"

    summary = str(raw.get("summary") or "").strip()
    if not summary:
        summary = (
            str(len(failed)) + " part(s) failed dimensional inspection."
            if failed
            else "All measured dimensions conform to the supplied specification."
        )

    return {
        "overall_status": overall,
        "summary": summary,
        "failed_parts": failed,
        "checks": checks,
    }

def _clash_scope_note(clash: Optional[Dict[str, Any]]) -> str:
    """
    Render the deterministic clash pre-check as prompt text.

    The framing matters: this result is computed in Python before the model is
    called, so the model is told to treat it as measured fact and is explicitly
    forbidden from deriving overlaps itself from the centre coordinates. That
    keeps the one reproducible finding reproducible - if the model were left to
    infer interference from `center_mm`, the same upload could yield different
    clash claims on different runs, which is exactly what this feature exists to
    prevent.
    """
    if not clash:
        return ""

    interferences = clash.get("interferences") or []
    grazes = clash.get("grazes") or []
    clearances = clash.get("clearances") or []
    excluded = clash.get("excluded_parts") or []
    caveat = str(clash.get("caveat") or "").strip()
    threshold = clash.get("min_reportable_overlap_mm")

    lines = ["CLASH PRE-CHECK (computed deterministically server-side):"]
    if interferences:
        lines.append(
            f"{len(interferences)} component pair(s) have overlapping outlines:"
        )
        for item in interferences:
            lines.append(
                f"  - {item.get('part_a')} and {item.get('part_b')} overlap by "
                f"{item.get('penetration_mm')} mm"
            )
    else:
        lines.append(
            "No component outlines overlap. Do NOT report an interference "
            "between any two components."
        )

    # The graze band is stated separately, and explicitly marked as not a
    # failure. Without this the model sees the pairs listed and reports them as
    # clashes itself, which would put back exactly the findings the threshold
    # was added to remove.
    if grazes:
        lines.append(
            f"{len(grazes)} further pair(s) overlap by less than the "
            f"{threshold} mm reporting threshold. These are NOT failures and must "
            f"not be reported as clashes - the overlap is inside the accuracy of "
            f"the check:"
        )
        for item in grazes:
            lines.append(
                f"  - {item.get('part_a')} and {item.get('part_b')} overlap by only "
                f"{item.get('penetration_mm')} mm"
            )

    if clearances:
        lines.append(f"{len(clearances)} pair(s) sit closer than the clearance threshold:")
        for item in clearances:
            lines.append(
                f"  - {item.get('part_a')} and {item.get('part_b')} are "
                f"{item.get('gap_mm')} mm apart"
            )

    if excluded:
        names = ", ".join(str(e.get("part_id")) for e in excluded)
        lines.append(
            "Not clash-checked (excluded, so absence of a finding is not clearance): " + names
        )

    lines.append(
        "Treat the above as VERIFIED MEASUREMENT. Do not compute or invent overlaps "
        "between components yourself - the centre and extent fields are provided for "
        "dimensional context only. If the specification imposes a clearance or "
        "fit requirement, evaluate it against these results."
    )
    if caveat:
        lines.append("Method caveat: " + caveat)

    return "\n".join(lines) + "\n\n"


def audit_against_specs(
    cad_metrics: Dict[str, Any],
    requirements: str,
    clash: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Run the LLM conformance audit.

    Args:
        cad_metrics: the dict returned by cad_processor.process_step_geometry.
        requirements: free-text engineering specification.
        clash: optional deterministic clash pre-check result (see
            clash_detector.detect_clashes). When supplied it is passed to the
            model as verified fact, and failure to do so would leave interference
            reporting to the model's own inference.

    Returns:
        {"overall_status", "summary", "failed_parts", "checks"}
    """
    # Measured in Python, so it survives every path that cannot reach the model.
    # Every early return below carries it, or an interference that was genuinely
    # measured would vanish behind an unrelated failure (a missing API key, say).
    known_part_ids = {
        str(c.get("part_id"))
        for c in cad_metrics.get("components") or []
        if c.get("part_id")
    }
    clash_checks = _clash_findings(clash, known_part_ids)

    if not cad_metrics.get("components"):
        return _empty_audit(
            "No measurable solids were found, so nothing could be audited.",
            clash_checks,
        )

    if not requirements or not requirements.strip():
        return _empty_audit(
            "No engineering requirements were supplied, so no conformance checks "
            "could be performed. The model geometry was extracted successfully.",
            clash_checks,
        )

    if not API_KEY:
        return _empty_audit(
            "Geometry extracted successfully, but no LLM API key is configured "
            "(set DEEPSEEK_API_KEY or OPENAI_API_KEY), so no audit was performed.",
            clash_checks,
        )

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL or None)

    # Tell the model up front whether ANY solid carried BIM properties. Without
    # this it tends to treat a geometry-only STEP model as a BIM model whose
    # properties are all missing, and reports conformance failures for data that
    # was never in scope.
    components = cad_metrics.get("components") or []
    has_properties = any(c.get("properties") for c in components)
    if has_properties:
        scope_note = (
            "BIM PROPERTY DATA: present. Some solids report `properties` "
            "(IFC psets/qtos) and/or ifc_class, material or predefined_type; "
            "evaluate the specification against them as instructed.\n\n"
        )
    else:
        scope_note = (
            "BIM PROPERTY DATA: absent. No solid carries an IFC property map, so "
            "this model is geometry-only (a STEP file, or an IFC file with no "
            "psets). Do NOT fail any check for a missing property; note the "
            "absence in `comment` instead.\n\n"
        )

    user_prompt = (
        scope_note
        + _clash_scope_note(clash)
        + "MEASURED CAD GEOMETRY (JSON):\n"
        + json.dumps(cad_metrics, indent=2)
        + "\n\nENGINEERING REQUIREMENTS:\n"
        + requirements.strip()
        + "\n\nAudit the model against these requirements and respond with JSON only."
    )

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0,
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content or "{}"
        return _normalise(json.loads(content), known_part_ids, clash)

    except json.JSONDecodeError as exc:
        logger.exception("LLM returned non-JSON content")
        return _empty_audit(
            "The audit model returned malformed JSON and could not be parsed: "
            + str(exc),
            clash_checks,
        )

    except Exception as exc:  # noqa: BLE001 - network/auth/rate-limit all land here
        logger.exception("LLM audit call failed")
        return _empty_audit(
            "The audit could not be completed: " + str(exc),
            clash_checks,
        )


# RESPONSE_SCHEMA documents the enforced contract. DeepSeek's OpenAI-compatible
# endpoint supports json_object mode rather than strict json_schema mode, so
# _normalise is what actually guarantees the shape reaching the frontend.

__all__ = ["audit_against_specs", "RESPONSE_SCHEMA"]
