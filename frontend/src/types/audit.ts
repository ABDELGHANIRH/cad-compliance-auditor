/**
 * Verdict of one check, or of a whole audit.
 *
 * Named because the same two values travel through the finding rows, the
 * per-audit status banner and the workbench header pill - a bare union repeated
 * in four places drifts apart silently.
 */
export type CheckStatus = 'PASS' | 'FAIL';

/** One parsed line of a finding's plain-English review. */
export interface PlainBullet {
  label: string;
  text: string;
}

/**
 * A finding's review, split into its labelled bullets.
 *
 * The backend emits `comment` as two paragraphs of "**Label:** sentence" -
 * Problem & Impact, then Action. The card renders each as its own labelled row,
 * so they are parsed once here rather than string-split at every render site.
 */
export type PlainReview = PlainBullet[];

/** A single requirement evaluated against the measured geometry. */
export interface CheckItem {
  check_name: string;
  part_id: string;
  status: CheckStatus;
  expected: string;
  found: string;
  fix_instruction: string;
  /**
   * The plain-English review, as three "**Label:** sentence" paragraphs.
   *
   * Always present on a fresh response — the backend normaliser assembles it
   * from the model's plain_* fields and synthesises an equivalent when they are
   * missing. Optional here only because older cached responses predate the
   * field; render defensively.
   */
  comment?: string;
}

/** Bounding-box extents of one solid, in millimetres. */
export interface ComponentDimensions {
  length_x: number;
  width_y: number;
  height_z: number;
}

/**
 * Geometric centre of one solid's bounding box, in millimetres.
 *
 * Computed server-side as the midpoint of the bounding box's min/max bounds, so
 * it is the part's own centre regardless of where the solid's local origin sits.
 */
export interface ComponentCenter {
  x: number;
  y: number;
  z: number;
}

/** One measured solid from the STEP or IFC file. */
export interface CadComponent {
  part_id: string;
  dimensions_mm: ComponentDimensions;
  /**
   * Centre of the solid's bounding box, in millimetres.
   *
   * Optional: the viewer falls back to the mesh origin when it is absent, which
   * keeps older cached responses and any backend predating this field working.
   */
  center_mm?: ComponentCenter;
  volume_mm3: number;
  /**
   * Distinct cylindrical face diameters in mm, largest first. Holes, bores and
   * screw shanks appear here; empty when the solid has no cylindrical features.
   *
   * Always empty for IFC input: IFC products arrive as triangulated meshes with
   * no analytic surface data, so bores are not measurable from an IFC file.
   */
  cylindrical_diameters_mm: number[];
  /**
   * BIM fields. Present only for IFC input, and only when the element actually
   * carries them - a STEP solid has none of these, and neither does an IFC
   * element with no type, material or property sets.
   */
  ifc_class?: string;
  predefined_type?: string;
  type_name?: string;
  material?: string;
  /**
   * Flattened IFC property and quantity sets, keyed `"<Pset>.<Property>"`,
   * e.g. `"Pset_WallCommon.FireRating": "REI60"`. Values are whatever the
   * property held: string, number or boolean.
   */
  properties?: Record<string, string | number | boolean>;
}

/** Raw geometry extracted by the backend. */
export interface CadMetrics {
  solid_count: number;
  components: CadComponent[];
}

/**
 * One pair of components whose bounding boxes overlap.
 *
 * This comes from a deterministic server-side pre-check, so it is the one part
 * of the response that is fully reproducible for a given upload - unlike the
 * LLM's verdict.
 */
export interface Interference {
  part_a: string;
  part_b: string;
  overlap_mm: { x: number; y: number; z: number };
  /** Smallest axis overlap: how far the parts must separate to stop clashing. */
  penetration_mm: number;
}

/** A pair that does not touch but sits closer than the clearance threshold. */
export interface Clearance {
  part_a: string;
  part_b: string;
  gap_mm: number;
}

/**
 * A pair of boxes that overlap only shallowly - below the detector's reporting
 * threshold - with the same fields an interference carries.
 *
 * Advisory, never a failure: an overlap this shallow is inside the error of an
 * axis-aligned box test, so it is a pair to look at rather than a defect.
 */
export interface BoxOverlap {
  part_a: string;
  part_b: string;
  overlap_mm: { x: number; y: number; z: number };
  penetration_mm: number;
}

/**
 * One box largely enclosing another: a part mounted inside a frame.
 *
 * Normal on a process skid - a vessel carried by a structural rack - and
 * excluded from the verdict for that reason. Recorded rather than discarded so
 * the reviewer can see which pairs the check set aside.
 */
export interface Containment {
  part_a: string;
  part_b: string;
  /** The part that sits inside the other. */
  contained: string;
  /** The part it sits inside. */
  host: string;
  /** How much of the smaller box lies inside the larger, 0-1. */
  overlap_ratio: number;
  penetration_mm: number;
}

/** A component the pre-check could not test, and why. */
export interface ExcludedPart {
  part_id: string;
  reason: string;
}

/** The deterministic geometric pre-check, computed before the LLM audit. */
export interface ClashResult {
  checked_pairs: number;
  excluded_parts: ExcludedPart[];
  interferences: Interference[];
  /**
   * Box overlaps too shallow to be called a clash. Optional: a response cached
   * from an older deployment predates the band.
   */
  grazes?: BoxOverlap[];
  /** Pairs read as one part mounted inside another. Optional, as above. */
  containments?: Containment[];
  min_reportable_overlap_mm?: number;
  containment_ratio?: number;
  clearances: Clearance[];
  /**
   * Always present. The test is axis-aligned bounding boxes, so it is
   * conservative rather than exact - a rotated part can report a false
   * interference. Surface this wherever clashes are presented; never show a
   * reported clash as a confirmed collision.
   */
  caveat: string;
}

/** The LLM's conformance verdict. */
export interface AuditResult {
  overall_status: CheckStatus;
  summary: string;
  /** part_ids that failed at least one check - these render red in the viewer. */
  failed_parts: string[];
  checks: CheckItem[];
}

/**
 * Which dropzone slot a model came from.
 *
 * Fixed wire names rather than the discipline labels themselves: the labels are
 * display strings (and carry the accepted extensions), so keying anything
 * structural off them would break the moment the wording changed.
 */
export type DisciplineKey = 'disciplineA' | 'disciplineB';

/**
 * One discipline's geometry within a federated response.
 *
 * Both fields are optional because the backend omits them for a single-model
 * audit: a response carrying only `model_url` is the pre-federation shape, and
 * the viewer treats it as discipline A.
 */
export interface DisciplineModel {
  model_url?: string;
  cad_metrics?: CadMetrics;
}

/** Response body of POST /api/audit. */
export interface AuditResponse {
  model_url: string;
  cad_metrics: CadMetrics;
  clash: ClashResult;
  audit: AuditResult;
  /**
   * Present only when both dropzone slots carried a file. Each discipline gets
   * its own GLB so the viewer can toggle them independently; the top-level
   * `model_url` / `cad_metrics` describe the merged assembly the audit ran on.
   */
  models?: Partial<Record<DisciplineKey, DisciplineModel>>;
}

// ---------------------------------------------------------------------------
// Engineer sign-off
// ---------------------------------------------------------------------------

/** An engineer's disposition of a single finding. */
export type DecisionVerdict = 'accepted' | 'rejected' | 'modified';

/**
 * One engineer sign-off.
 *
 * `accepted` means the engineer agrees with the finding as reported, whether it
 * passed or failed. `rejected` means they disagree with it. `modified` means the
 * geometry is to change - the reviewer's own action item.
 */
export interface Decision {
  verdict: DecisionVerdict;
  notes: string;
  /** ISO timestamp, so the exported report can show when the call was made. */
  decidedAt: string;
}

/** Every decision in the session, keyed by the check identity (see decisions.ts). */
export type DecisionMap = Record<string, Decision>;

/** Sign-off progress across the whole audit. */
export interface ReviewProgress {
  reviewed: number;
  total: number;
  accepted: number;
  rejected: number;
  modified: number;
  complete: boolean;
}

// ---------------------------------------------------------------------------
// Reviewer identity and comment threads
// ---------------------------------------------------------------------------

/**
 * Who is writing review comments.
 *
 * A single local identity rather than a login: the workbench is a single-user
 * tool, and the point of the name is that a comment in the exported report
 * carries an author, not that it is authenticated. Persisted so a reviewer
 * types it once per browser rather than once per comment.
 */
export interface Reviewer {
  name: string;
  role: string;
}

export const DEFAULT_REVIEWER: Reviewer = {
  name: 'Lead Engineer',
  role: 'Reviewer',
};

/**
 * The disciplines that share the review, as the demo's switchable identities.
 *
 * `DEFAULT_REVIEWER.role` is deliberately NOT here. A reviewer who has set
 * their own free-text role must not lose it the moment they open the role
 * switcher, so the switcher offers these three and treats the stored role as an
 * extra, unlisted option rather than as invalid.
 *
 * The order is the order the switcher lists them in: the quality call first,
 * then the two disciplines whose work the findings are actually about.
 */
export const DISCUSSION_ROLES = [
  'Quality Controller',
  'Piping Engineer',
  'Electrical Engineer',
] as const;

/** One of the switchable discussion identities, or any free-text role. */
export type DiscussionRole = string;

/**
 * Short form of a role, for the badge on a comment bubble.
 *
 * The full name is the identity and is what the switcher and the exported
 * report carry, but it is too wide for a badge sitting between an author's name
 * and a timestamp in a 460 px dock - a full "Electrical Engineer" chip pushes
 * both out of the row. `initials` cannot express these: "QC" is the recognised
 * abbreviation of Quality Controller, not a pair of initials to guess at.
 */
export function roleShortLabel(role: string): string {
  switch (role.trim().toLowerCase()) {
    case 'quality controller':
      return 'QC';
    case 'piping engineer':
      return 'Piping';
    case 'electrical engineer':
      return 'Electrical';
    default:
      return role.trim() || 'Reviewer';
  }
}

/**
 * Where the 3D camera was standing when a comment was written.
 *
 * Stored on the comment rather than derived later because the pose only exists
 * at the moment of writing: the reviewer posts mid-inspection, orbits away, and
 * the angle they meant is gone. `commentViewpoint` returns a copy that is safe
 * to persist.
 */
export interface Viewpoint {
  /** Camera position, in the viewer's normalised world units. */
  position: [number, number, number];
  /** The point the camera was aimed at - the orbit target. */
  target: [number, number, number];
}

/** One comment posted against a finding. */
export interface ReviewComment {
  /** Stable id, used as the React key and for delete. */
  id: string;
  /** The author's name as it was when the comment was posted. */
  author: string;
  /** The author's role badge at the time of posting. */
  role: string;
  body: string;
  /** ISO timestamp, so the card and the report can show when it was written. */
  createdAt: string;
  /**
   * The camera angle the author was inspecting, when one was captured.
   *
   * Optional and absent by default: a comment written from the feed with the
   * viewer untouched carries no angle, and offering "Look at this view" on it
   * would fly the reader somewhere the author never actually stood.
   */
  viewpoint?: Viewpoint;
  /**
   * The point on the model the comment is about, in the viewer's world units.
   *
   * The other half of `viewpoint`, and captured for the same reason: `viewpoint`
   * records where the author stood, this records what they were standing in
   * front of. Together they are what lets a reader who was not in the room
   * arrive at the same view of the same defect - the angle alone still leaves
   * them hunting for the coordinate, which for a five-metre pipe run is most of
   * the work.
   *
   * World units rather than the raw file millimetres `ComponentCenter` holds:
   * this is written by the scene, from a coordinate the scene already resolved
   * through the Z-up -> Y-up rotation and the federated placement, so it is
   * directly comparable with a camera position and needs no second transform at
   * the point of use.
   *
   * Optional, and absent whenever nothing resolvable was on screen when the
   * comment was written - no finding open, or a finding the viewer could not
   * anchor to a coordinate. `readAnchor` drops a malformed value the same way
   * `readViewpoint` does, degrading the comment to a plain one rather than
   * discarding it.
   */
  anchor?: [number, number, number];
}

/** Every comment in the session, keyed by the check identity (see decisions.ts). */
export type CommentMap = Record<string, ReviewComment[]>;

/**
 * One comment as the 3D viewer needs it: the words, and where to put them.
 *
 * Deliberately a flattened copy rather than the `ReviewComment` itself. The
 * viewer's marker layer is built to be free of both `CheckItem` and the comment
 * store - it is handed coordinates and numbers, and it asks for a finding's
 * prose only for the one marker that is open. A cloud layer that took the raw
 * `CommentMap` would have to know about thread keys and finding identity, which
 * is exactly the coupling that separation exists to prevent.
 *
 * `threadKey` is carried anyway, because a cloud that is opened needs to say
 * which finding it belongs to - but it is an opaque string here, not something
 * this layer resolves.
 *
 * `anchor` is required, unlike on `ReviewComment`. This type only exists for
 * comments that have a place on the model; the ones without are filtered out
 * before a `ViewerAnnotation` is ever constructed, so the cloud layer never has
 * to ask "and where would this go".
 */
export interface ViewerAnnotation {
  /** The comment's own id, so the cloud and the card are the same object. */
  id: string;
  body: string;
  author: string;
  role: string;
  createdAt: string;
  /** The point on the model, in the viewer's world units. */
  anchor: [number, number, number];
  /** The finding thread this comment belongs to, for opening the card. */
  threadKey: string;
}

/**
 * The finding category shown as a pill tag on each review card.
 *
 * Derived on the client from the check's own text rather than asked of the
 * model: the backend contract has no category field, and a mis-categorised tag
 * is a cosmetic error, whereas a new required field would be a breaking change
 * to a response shape the exported JSON also records.
 */
export type FindingCategory =
  | 'Dimensional Compliance'
  | 'Clearance & Clash'
  | 'Safety'
  | 'Material & Property'
  | 'Design Review';

/**
 * How loudly a finding should present itself.
 *
 * Derived on the client from `status` plus whether the finding carries a
 * measured clash, in the same spirit as `FindingCategory` above: the backend
 * contract has no severity field, and a derived one keeps the response shape
 * the exported JSON records unchanged.
 *
 * The distinction that earns a level of its own is `warning` versus `critical`:
 * a FAIL with a deterministic measurement behind it is a fact about the model,
 * where a FAIL resting on the model's reading of a specification is a judgement
 * that can be argued with. Rendering both as "FAIL" hides a difference the
 * reviewer acts on.
 */
export type FindingSeverity = 'critical' | 'warning' | 'advisory' | 'clear';

/** Human-readable label for a part identifier. */
export function partLabel(partId: string | null | undefined): string {
  if (!partId || partId === 'assembly') return 'Assembly';
  return partId;
}

/** Two-letter initials for an avatar, from a display name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Label for a decision verdict, for chips and the exported report. */
export function verdictLabel(verdict: DecisionVerdict): string {
  switch (verdict) {
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'modified':
      return 'Change required';
  }
}
