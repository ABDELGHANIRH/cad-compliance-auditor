import type {
  CheckItem,
  CommentMap,
  FindingCategory,
  FindingSeverity,
  PlainReview,
  Reviewer,
  ReviewComment,
  Viewpoint,
} from '@/types/audit';
import { DEFAULT_REVIEWER } from '@/types/audit';
// Safe to import: decisions.ts depends only on types/audit, so this cannot form
// a cycle. Sharing `decisionKey` is deliberate - comments and sign-offs are two
// maps over one identity, and re-deriving that identity here would let the two
// drift apart silently.
import { decisionKey, teamChannelKey } from '@/lib/decisions';

/**
 * Parsing and classification helpers for the review stream.
 *
 * Kept apart from `decisions.ts` because none of this is state: it is the pure
 * translation from a backend finding to the shape the review card renders.
 */

/** Matches one "**Label:** text" line of the backend's plain-English comment. */
const BULLET_RE = /^\*\*([^:*]+):\*\*\s*(.+)$/;

/**
 * Split a finding's `comment` into its labelled bullets.
 *
 * The backend emits two paragraphs - `**Problem & Impact:** ...` and
 * `**Action:** ...` - separated by a blank line, but this tolerates a single
 * newline too, because the value may have been through a JSON round-trip.
 *
 * The label text is not matched here: the card reads the bullets back by
 * keyword, so an older cached response carrying the three-bullet `Status:` /
 * `Measurement:` / `Recommended Action:` shape parses through the same path.
 *
 * Returns [] for an absent comment, and falls back to a single unlabelled
 * bullet for text that carries no labels at all — an older cached response, or
 * a model that ignored the format. Never returns a bullet with empty text, so
 * the card cannot render a labelled blank row.
 */
export function parsePlainReview(comment: string | undefined): PlainReview {
  const text = (comment ?? '').trim();
  if (!text) return [];

  const bullets: PlainReview = [];
  for (const raw of text.split(/\n\s*\n|\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const match = BULLET_RE.exec(line);
    if (match) {
      const label = match[1].trim();
      const body = match[2].trim();
      if (body) bullets.push({ label, text: body });
      continue;
    }

    // Unlabelled text: keep it rather than dropping the only explanation the
    // finding has. It renders as a bullet with no label. Consecutive unlabelled
    // lines are joined into one bullet, since a paragraph split across lines by
    // the model is one thought, not several.
    const last = bullets.length - 1;
    if (last >= 0 && !bullets[last].label) {
      // Replaced, not mutated: the returned array must not alias objects the
      // caller already holds, or two call sites memoising the same comment
      // could diverge depending on which ran first.
      bullets[last] = { label: '', text: `${bullets[last].text} ${line}` };
    } else {
      bullets.push({ label: '', text: line });
    }
  }

  return bullets;
}

/** Keywords that place a finding in each category, most specific first. */
const CATEGORY_RULES: { category: FindingCategory; pattern: RegExp }[] = [
  {
    category: 'Safety',
    pattern:
      /\b(fire|rating|rei\s?\d|smoke|egress|escape|hazard|safety|guard|protective|emergency|load[- ]?bearing|structural|collapse)\b/i,
  },
  {
    category: 'Clearance & Clash',
    pattern:
      /\b(clash\w*|interfer\w*|clearance|clear\b|overlap\w*|collision|collide\w*|penetrat\w*|spacing|gap|fits?\b|fitting|assembly)\b/i,
  },
  {
    category: 'Material & Property',
    pattern:
      /\b(material|grade|steel|aluminium|aluminum|concrete|coating|finish|thermal|acoustic|insulat|property|properties|manufacturer|model reference|thickness class)\b/i,
  },
  {
    category: 'Dimensional Compliance',
    // No bare "mm" here: it is far too weak a signal, and every finding carries
    // units somewhere, so it would type the fallback case as dimensional. The
    // named quantities below are what actually distinguish this category.
    pattern:
      /\b(length|width|height|depth|diameter|radius|thickness|dimension|dimensional|bore|hole|footprint|extent|volume|tolerance|position|measurement)\w*\b/i,
  },
];

/**
 * Classify a finding for its pill tag.
 *
 * The check's NAME is decisive and is tested on its own first: it states what
 * the requirement actually is ("Pump must clear the skid frame"), whereas the
 * explanation is prose that can mention anything - a footprint check whose
 * recommended action reads "reposition it so it fits the frame" would otherwise
 * be tagged a clearance problem purely because of how the fix is worded.
 *
 * Only when the name matches nothing is the rest of the finding searched, and
 * then most-specific-first: a fire-rating check that also mentions wall
 * thickness is a Safety finding, not a Dimensional one.
 *
 * Falls back to `Design Review` — a real category, not an error state: a
 * qualitative finding genuinely belongs there.
 */
export function categorise(check: CheckItem): FindingCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(check.check_name)) return rule.category;
  }

  const haystack = [
    check.expected,
    check.found,
    check.comment ?? '',
    check.fix_instruction,
  ].join(' ');

  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }
  return 'Design Review';
}

/** Tailwind classes for a category pill, kept distinguishable without colour alone. */
export function categoryStyle(category: FindingCategory): string {
  switch (category) {
    case 'Safety':
      return 'bg-rose-500/10 text-rose-300 ring-rose-500/25';
    case 'Clearance & Clash':
      return 'bg-amber-500/10 text-amber-300 ring-amber-500/25';
    case 'Material & Property':
      return 'bg-violet-500/10 text-violet-300 ring-violet-500/25';
    case 'Dimensional Compliance':
      return 'bg-sky-500/10 text-sky-300 ring-sky-500/25';
    case 'Design Review':
      return 'bg-slate-500/10 text-slate-300 ring-slate-500/25';
  }
}

/**
 * The severity band a finding presents at.
 *
 * `critical` is reserved for a FAIL that the deterministic pre-check measured -
 * a box overlap, which is the one part of the verdict that is reproducible for
 * a given upload. A FAIL resting on the model's reading of the specification is
 * `warning`, because it is a judgement rather than a measurement and the
 * reviewer may reasonably disagree with it. Both are failures; the band says
 * how much weight the finding carries, not whether it passed.
 *
 * An advisory check is one the backend deliberately reported as PASS so it
 * would reach the feed without being presented as a fault - a graze or a
 * clearance near-miss. `clear` is an ordinary pass.
 *
 * Note the ordering of the tests: status is checked first, so a PASS can never
 * come back as critical however its wording reads.
 */
export function severityOf(check: CheckItem): FindingSeverity {
  if (check.status !== 'FAIL') {
    return categorise(check) === 'Clearance & Clash' && check.expected === ''
      ? 'advisory'
      : 'clear';
  }

  // A measured clash names two parts and carries no target value, because a
  // collision is not a dimension with a specification behind it. That is the
  // same shape the backend's synthesiser writes, so it identifies the band
  // without the card having to reach for the clash result itself.
  const isMeasuredClash =
    categorise(check) === 'Clearance & Clash' && !check.expected.trim();
  return isMeasuredClash ? 'critical' : 'warning';
}

/**
 * The one sentence that says what is wrong, for the viewport bubble.
 *
 * Deliberately narrower than the card's summary: a marker is a pointer at a
 * coordinate, not a card, and the fix instruction belongs on the card the marker
 * opens - a reader who wants the remedy is already being taken to it. So this
 * takes the problem bullet and stops, where `FindingCard`'s summary appends the
 * action for a FAIL.
 *
 * Reads the bullets back through `parsePlainReview`, the same parser the card
 * uses, so one comment cannot be read two ways. The label match is by keyword
 * rather than by name because the backend has shipped two shapes: "Problem &
 * Impact" on a fresh response and "Status" on a cached one.
 *
 * Falls back the way the card does - to the raw comment with its `**Label:**`
 * markers stripped - so a response that ignored the format still says something
 * in the bubble rather than leaving it empty. Returns '' when there is nothing to
 * say, and the caller is expected to render a bubble without a body rather than
 * an empty one.
 */
export function findingProblem(check: CheckItem): string {
  const review = parsePlainReview(check.comment);

  const problem = review.find((bullet) => /problem|impact|status/i.test(bullet.label));
  if (problem) return problem.text;

  // An unlabelled first bullet is the explanation, not the action, so it is the
  // right fallback - and it is what an older cached response looks like.
  const unlabelled = review.find((bullet) => !bullet.label);
  if (unlabelled) return unlabelled.text;

  return (check.comment ?? '').replace(/\*\*[^:]+:\*\*\s*/g, '').trim();
}

/** The word shown on a finding's severity chip. */
export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  advisory: 'Advisory',
  clear: 'Pass',
};

/**
 * The severity bands, worst first.
 *
 * One ordering shared by the severity roll-up's sort and its "worst band for
 * this part" lookup, so the two cannot disagree about what is more serious.
 */
export const SEVERITY_ORDER: FindingSeverity[] = [
  'critical',
  'warning',
  'advisory',
  'clear',
];

/**
 * The accent colour for a severity band, as a hex value.
 *
 * Hex rather than a Tailwind class because the same colour has to reach three
 * places that do not share a styling context: the card's left border, the 3D
 * callout's stroke (drawn into an SVG and a canvas material), and the severity
 * roll-up rows. One source keeps them from drifting.
 */
export const SEVERITY_COLOR: Record<FindingSeverity, string> = {
  critical: '#EF4444',
  warning: '#F59E0B',
  advisory: '#38BDF8',
  clear: '#10B981',
};

// ---------------------------------------------------------------------------
// Reviewer identity
// ---------------------------------------------------------------------------

const REVIEWER_KEY = 'cad-auditor.reviewer.v1';

/** Read the stored reviewer, falling back to the default identity. */
export function loadReviewer(): Reviewer {
  if (typeof window === 'undefined') return DEFAULT_REVIEWER;
  try {
    const raw = window.localStorage.getItem(REVIEWER_KEY);
    if (!raw) return DEFAULT_REVIEWER;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_REVIEWER;

    const candidate = parsed as Partial<Reviewer>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const role = typeof candidate.role === 'string' ? candidate.role.trim() : '';
    if (!name) return DEFAULT_REVIEWER;
    return { name, role: role || DEFAULT_REVIEWER.role };
  } catch {
    return DEFAULT_REVIEWER;
  }
}

export function saveReviewer(reviewer: Reviewer): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REVIEWER_KEY, JSON.stringify(reviewer));
  } catch {
    // Storage unavailable — the identity stays in memory for this session.
  }
}

// ---------------------------------------------------------------------------
// Comment threads
// ---------------------------------------------------------------------------

const COMMENTS_KEY = 'cad-auditor.comments.v1';

/**
 * A three-number tuple, or null when the value is not one.
 *
 * Shared by the live capture and the stored read so a pose that came off the
 * camera and one that came out of localStorage are held to the same standard.
 */
function triple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * Read the live camera pose from the viewer, or null when there is none.
 *
 * The viewer publishes this surface for its own end-to-end tests (see
 * `CameraRig`), and it is exactly what a "linked viewpoint" needs: the pose the
 * camera is actually holding, at the moment the reviewer posts. Reading it here
 * rather than lifting the pose into React state is deliberate - the camera
 * changes every frame, and a pose in state would re-render the stream, the
 * cards and the panel at 60 fps for a value that is only ever read once, by a
 * button click.
 *
 * Every failure mode returns null: the viewer may be unmounted (the panel
 * renders before the first audit), OrbitControls may not have attached yet, or
 * the surface may be the stub from a different build. A comment written then
 * simply carries no viewpoint, which the bubble renders as an ordinary comment
 * rather than as a broken one.
 */
export function captureViewpoint(): Viewpoint | null {
  if (typeof window === 'undefined') return null;
  try {
    const surface = window as unknown as {
      __cadViewerCamera?: () => { position?: unknown; target?: unknown };
    };
    if (typeof surface.__cadViewerCamera !== 'function') return null;

    const pose = surface.__cadViewerCamera();
    const position = triple(pose?.position);
    const target = triple(pose?.target);
    if (!position || !target) return null;

    return { position, target };
  } catch {
    return null;
  }
}

/**
 * Read the defect coordinate the viewer is currently framing, or null.
 *
 * The counterpart to `captureViewpoint`, and read from the same published
 * surface for the same reason: the coordinate lives in the scene, changes with
 * the audit and the placement, and is only ever read once - by the click that
 * posts the comment. Lifting it into React state would re-render the workbench
 * on every marker open to feed a value nothing renders.
 *
 * Null covers the cases where there is honestly nothing to point at: the viewer
 * unmounted, no finding open, or a finding the viewer could not anchor to a
 * coordinate. A comment posted then carries no anchor and simply does not appear
 * over the model - which is the correct outcome, since a cloud in a made-up
 * position is worse than none.
 */
/**
 * Short clock time for a message, e.g. "10:42 AM".
 *
 * The feed's own relative time ("3 min ago") is the right reading for a finding
 * raised by the audit, which has no meaningful clock time of its own. A
 * conversation is different: two messages a minute apart both read "1 min ago",
 * and the exchange loses its shape. A wall clock orders them.
 *
 * Locale-formatted rather than hand-assembled, so a 24-hour locale gets
 * "10:42" and a 12-hour one gets "10:42 AM" without a setting.
 *
 * Lives here rather than in the discussion panel because the 3D viewer's comment
 * clouds show the same timestamps, and a component module is not the place for a
 * formatter two components need - importing a panel from a viewer would pull one
 * component tree into another for a single function.
 */
export function clockTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Full timestamp for the `title` attribute, where precision is free. */
export function fullTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function captureAnchor(): [number, number, number] | null {
  if (typeof window === 'undefined') return null;
  try {
    const surface = window as unknown as {
      __cadViewerFindingAnchor?: () => unknown;
    };
    if (typeof surface.__cadViewerFindingAnchor !== 'function') return null;
    return triple(surface.__cadViewerFindingAnchor());
  } catch {
    return null;
  }
}

/**
 * Rebuild a stored viewpoint field by field, or drop it.
 *
 * A pose that fails this is not worth preserving: it would fly another user's
 * camera to NaN, and the failure would surface as a blank viewport rather than
 * as anything a reader could attribute to a bad comment. Dropping it degrades
 * the message to a plain comment.
 */
function readViewpoint(value: unknown): Viewpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { position?: unknown; target?: unknown };
  const position = triple(candidate.position);
  const target = triple(candidate.target);
  return position && target ? { position, target } : undefined;
}

/**
 * Rebuild a stored anchor, or drop it.
 *
 * Held to exactly the standard `readViewpoint` holds a pose to, and for the
 * same reason: the value goes on to steer a camera, so a malformed one is not
 * worth repairing. It would fly the reader to NaN and blank the viewport rather
 * than failing in any way they could attribute to a bad comment. Dropping it
 * degrades the comment to one with no cloud over the model.
 */
function readAnchor(value: unknown): [number, number, number] | undefined {
  return triple(value) ?? undefined;
}

/**
 * Read persisted comments.
 *
 * Every failure mode returns an empty map rather than throwing, for the same
 * reason `loadDecisions` does: storage can be unavailable, hold a value written
 * by an older build, or have been edited by hand, and a demo must load either
 * way.
 */
export function loadComments(): CommentMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(COMMENTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: CommentMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const thread: ReviewComment[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Partial<ReviewComment>;
        const body = typeof candidate.body === 'string' ? candidate.body.trim() : '';
        if (!body) continue;
        thread.push({
          id: typeof candidate.id === 'string' && candidate.id ? candidate.id : makeId(),
          author:
            typeof candidate.author === 'string' && candidate.author.trim()
              ? candidate.author
              : DEFAULT_REVIEWER.name,
          role:
            typeof candidate.role === 'string' && candidate.role.trim()
              ? candidate.role
              : DEFAULT_REVIEWER.role,
          body,
          createdAt:
            typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
          // Restored through the same validator the live capture uses, so a pose
          // that was truncated, hand-edited or written by an older build is
          // dropped here rather than flown to by another user's camera.
          viewpoint: readViewpoint(candidate.viewpoint),
          // And the anchor through its own, for the same reason: it steers the
          // camera on a cloud click, so a value that is not three finite
          // numbers must not survive the read.
          anchor: readAnchor(candidate.anchor),
        });
      }
      if (thread.length > 0) result[key] = thread;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveComments(comments: CommentMap): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(comments).length === 0) {
      window.localStorage.removeItem(COMMENTS_KEY);
      return;
    }
    window.localStorage.setItem(COMMENTS_KEY, JSON.stringify(comments));
  } catch {
    // Storage full or unavailable — comments stay in memory for this session.
  }
}

export function clearComments(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(COMMENTS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Drop comment threads that no longer belong to a check.
 *
 * The same reasoning as `reconcileDecisions`: threads are keyed by check
 * identity, which only means anything relative to the response they were made
 * against. Without this, a previous model's thread would reappear on a new
 * upload that happens to reuse `part_1`.
 *
 * The FULL key is validated, not just the trailing index. An index-only check
 * would keep a thread whose part and requirement no longer match but whose
 * position still exists, and then render it against whichever finding now
 * occupies that position - which is exactly the misattribution this function
 * is here to prevent.
 *
 * Re-running an audit of the same file reproduces the same part ids and, in
 * practice, the same check names, so those threads are correctly kept.
 *
 * SAFETY GATE. This function DELETES data: every key absent from `checks` is
 * pruned, and the result is what `saveComments` writes back to storage. That is
 * correct only when `checks` is the complete finding list of a finished audit,
 * because then a key that does not match genuinely cannot belong to anything.
 * Two situations look identical from here but must not prune:
 *
 *   - `checks` is empty. A tab that has not run an audit holds no findings, and
 *     pruning against an empty list would delete every thread the reviewer has
 *     written in another tab. An empty finding list is not evidence that the
 *     stored threads are stale - it is evidence that this tab knows nothing.
 *   - `checks` is a proper subset of the stored keys. That is the signature of a
 *     partial or federated view rather than a complete response, and pruning
 *     would delete threads for findings this tab simply is not rendering.
 *
 * In both cases the stored map is returned BY IDENTITY, untouched: callers hold
 * it in React state, so returning a copy would re-render every card for a
 * decision that changes nothing.
 */
export function reconcileComments(
  stored: CommentMap,
  checks: CheckItem[],
): { comments: CommentMap; dropped: number } {
  const storedKeys = Object.keys(stored);

  // The gate. Nothing is dropped while `checks` cannot vouch for the map as a
  // whole - see the note above.
  if (storedKeys.length > 0 && !isCompleteCheckList(checks, storedKeys)) {
    return { comments: stored, dropped: 0 };
  }

  const valid = new Set(checks.map((check, index) => decisionKey(check, index)));
  // The team channel is not attached to any finding, so it has no key in
  // `valid` and would be pruned on the next load - silently deleting every
  // message the team had written. It is kept unconditionally: it is keyed on
  // the audit, and re-auditing the same model is exactly when a note about it
  // is still worth having.
  valid.add(teamChannelKey());

  const kept: CommentMap = {};
  let dropped = 0;

  for (const [key, thread] of Object.entries(stored)) {
    if (valid.has(key)) kept[key] = thread;
    else dropped += 1;
  }

  return { comments: kept, dropped };
}

/**
 * Whether `checks` can be trusted as the complete finding list for `stored`.
 *
 * Deliberately strict: a non-empty list is not enough. Every stored key must be
 * accounted for, so a tab that has loaded only part of a review cannot use this
 * to prune the rest of it.
 */
function isCompleteCheckList(checks: CheckItem[], storedKeys: string[]): boolean {
  if (checks.length === 0) return false;
  const valid = new Set(checks.map((check, index) => decisionKey(check, index)));
  return storedKeys.every((key) => valid.has(key));
}

/** Count every comment across the session, for the panel header badge. */
export function commentCount(comments: CommentMap): number {
  return Object.values(comments).reduce((total, thread) => total + thread.length, 0);
}

/**
 * A collision-resistant id for a comment.
 *
 * `crypto.randomUUID` is unavailable on insecure origins in some browsers, so
 * this falls back to a timestamp/random pair rather than throwing.
 */
export function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
