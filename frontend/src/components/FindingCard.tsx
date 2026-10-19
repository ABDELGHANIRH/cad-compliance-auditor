'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Wrench,
  XCircle,
} from 'lucide-react';
import {
  partLabel,
  verdictLabel,
  type CheckItem,
  type Decision,
  type DecisionVerdict,
  type FindingCategory,
  type FindingSeverity,
  type PlainBullet,
  type Reviewer,
  type ReviewComment,
  type Viewpoint,
} from '@/types/audit';
import {
  categorise,
  parsePlainReview,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  severityOf,
} from '@/lib/review';
import LiveDiscussion, { DiscussionSummary } from '@/components/LiveDiscussion';

/** A short, human relative time for a comment or decision ("3 min ago"). */
function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Absolute timestamp for the `title` attribute.
 *
 * `relativeTime` is computed once per render, so a card left open drifts out of
 * date. It stays readable anyway because the exact time is always one hover
 * away, and re-rendering the whole stream on a timer to keep "3 min ago"
 * truthful would cost more than it is worth here.
 */
function fullTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/**
 * The Expected / Found comparison, on one inline row.
 *
 * Previously two bordered blocks each carrying its own label chip, which made
 * the single comparison the loudest thing on the card. It is one sentence worth
 * of information, so it is set as one line of text: labels in the quiet
 * secondary tone, values in tabular figures so the numbers line up down the
 * panel, and only the measured value coloured - and only when it failed.
 */
function MetricRow({ check }: { check: CheckItem }) {
  const failed = check.status === 'FAIL';

  // When a measurement could not be taken, the backend puts the explanation in
  // BOTH `found` and the status sentence, so printing both repeats a whole
  // sentence verbatim. In that case the summary above already says it, and the
  // row keeps only the target it was measured against.
  const foundIsProse = check.found.split(/\s+/).length > 4;

  /*
    A clash has no target value and no measurement to compare.

    The row was rendering "Target:  | Measured: 219.58 mm" on every overlap
    finding, and both halves were wrong. There is no specification value the
    overlap was checked against - the backend deliberately leaves `expected`
    empty for a clash - so the row led with an empty target, and the number
    beside it is the depth of a bounding-box intersection, not a dimension any
    drawing states. Showing it invited the reviewer to judge 219.58 mm against a
    tolerance that does not exist.

    The measurement is not lost: it is in the finding's own sentence ("move one
    of them at least 219.58 mm clear"), where it reads as the advice it is.
  */
  if (!check.expected.trim() && failed) return null;

  // Nothing measurable and no target to compare it to: the rows below already
  // carry the finding, so an "Expected: n/a | Actual:" ribbon would be noise.
  if (!check.expected.trim() && (!check.found.trim() || foundIsProse)) return null;

  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px]">
      <span className="text-slate-500">
        Target:{' '}
        <span className="font-mono tabular-nums text-slate-700">{check.expected}</span>
      </span>
      {!foundIsProse && (
        <>
          <span aria-hidden className="text-slate-300">
            |
          </span>
          <span className="text-slate-500">
            Measured:{' '}
            <span
              className={
                'font-mono tabular-nums ' +
                (failed ? 'text-rose-700' : 'text-slate-700')
              }
            >
              {check.found}
            </span>
          </span>
        </>
      )}
    </p>
  );
}

/**
 * One labelled sentence of the finding's review.
 *
 * The backend sends its review as two `**Label:** sentence` paragraphs, and
 * this card used to print the raw string - so the asterisks and the label text
 * appeared verbatim in the body. The label is a UI affordance, not content, so
 * it is rendered here as a quiet chip above its sentence instead of as literal
 * punctuation inside it.
 */
function ReviewRow({ label, text, tone }: { label: string; text: string; tone: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      {/*
        Title case, not upper case. These were set in caps with wide tracking,
        which gave two shouting labels per card the same visual weight as the
        finding's own title - so the eye read "PROBLEM & IMPACT" and "ACTION" as
        the content and skimmed the sentences underneath, which are the content.
        Sentence case reads as a label for the line below it, which is what it
        is, and matches the reference layout.
      */}
      <span className={'text-[10px] font-medium ' + tone}>{label}</span>
      <p className="text-xs leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

/**
 * The finding's review, as the two labelled rows the backend already wrote.
 *
 * @param rows  the bullets of `comment`, in the order the backend emitted them.
 * @param fallback  one unlabelled sentence for a response that carried no usable
 *   bullets at all - an older cached shape, or a model that ignored the format.
 *   It renders as a single row carrying no label, which is what the raw comment
 *   replaced used to approximate.
 */
function ReviewBlock({ rows, fallback }: { rows: PlainBullet[]; fallback: string }) {
  if (rows.length === 0) {
    if (!fallback.trim()) return null;
    return (
      <div className="flex flex-col gap-2">
        <ReviewRow label="Finding" text={fallback} tone="text-slate-600" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <ReviewRow
          key={`${row.label}-${index}`}
          // An unlabelled bullet is still a finding; naming it beats an empty
          // chip sitting above a sentence.
          label={row.label || 'Finding'}
          text={row.text}
          // Problem reads as neutral information and takes the slate label; the
          // Action is the one with a consequence attached, so it carries the
          // amber the sign-off controls already use for "change required".
          tone={/action/i.test(row.label) ? 'text-amber-700' : 'text-slate-600'}
        />
      ))}
    </div>
  );
}

/**
 * The finding, as one or two plain sentences.
 *
 * The backend sends its review as two labelled paragraphs - Problem & Impact,
 * then Action - and the card used to print all three of the older Status /
 * Measurement / Recommended Action set with their labels, repeating the
 * measurement twice (once in the labelled block, once in the Expected/Found
 * row).
 *
 * This collapses them. Labels are dropped, and any measurement bullet is
 * discarded outright because `MetricRow` already states it numerically; what
 * remains is the problem sentence and, for a failure, the action. A pass needs
 * no action, so it reduces to one line.
 */
function findingSummary(check: CheckItem, review: PlainBullet[]): string {
  const bulletBy = (pattern: RegExp) =>
    review.find((bullet) => pattern.test(bullet.label))?.text ?? '';

  // "Problem & Impact" on a fresh response, "Status" on a cached one; the
  // measurement bullet of a cached three-bullet response is skipped on purpose.
  const status = bulletBy(/problem|impact|status/i);
  const action = bulletBy(/action/i);

  const sentences = [status].filter(Boolean);

  if (check.status === 'FAIL') {
    // Prefer the review's own action wording; fall back to the backend's
    // dedicated fix field, which is the same instruction written for a drafter.
    const fix = action || check.fix_instruction;
    if (fix) sentences.push(fix);
  }

  // A response that carried no usable bullets (older cached shape) falls back to
  // whatever prose it did send rather than rendering an empty line.
  return sentences.length > 0
    ? sentences.join(' ')
    : (check.comment ?? '').replace(/\*\*[^:]+:\*\*\s*/g, '').trim();
}

/**
 * The severity band, as a labelled chip.
 *
 * Sits beside the status pill rather than replacing it: the pill states the
 * verdict (PASS/FAIL), this states how much weight the finding carries, and the
 * two are genuinely different questions - an advisory check is a PASS that is
 * worth reading, a critical one is a FAIL backed by a measurement rather than
 * by the model's reading of a specification.
 *
 * Colour is never the only signal; the word is spelled out beside the dot.
 */
function SeverityTag({ severity }: { severity: FindingSeverity }) {
  if (severity === 'clear') return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-medium"
      style={{ color: SEVERITY_COLOR[severity] }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: SEVERITY_COLOR[severity] }}
      />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

/**
 * Category label colour, as plain text rather than a filled pill.
 *
 * The category is metadata about the finding, not a verdict, and a row of
 * coloured pills above the title competed with the one pill that does mean
 * something (the status). Kept distinguishable without relying on colour alone,
 * since the label text itself says which category it is.
 */
const CATEGORY_TONE: Record<FindingCategory, string> = {
  Safety: 'text-rose-700',
  'Clearance & Clash': 'text-amber-700',
  'Material & Property': 'text-violet-700',
  'Dimensional Compliance': 'text-sky-700',
  'Design Review': 'text-slate-500',
};

/** Small status pill. The only place colour is allowed to carry the verdict. */
function StatusPill({ failed }: { failed: boolean }) {
  return (
    <span
      className={
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ' +
        (failed
          ? 'bg-rose-50 text-rose-700 border-rose-200'
          : 'bg-emerald-50 text-emerald-700 border-emerald-200')
      }
    >
      {failed ? (
        <XCircle className="h-3 w-3" aria-hidden />
      ) : (
        <CheckCircle2 className="h-3 w-3" aria-hidden />
      )}
      {failed ? 'FAIL' : 'PASS'}
    </span>
  );
}

/**
 * One sign-off control.
 *
 * A compact ghost/outline pill. These were bordered boxes with a coloured
 * border, coloured label and a coloured hover fill, which gave three loud
 * controls per card a weight that competed with the finding itself. Now the
 * resting state is neutral and the verdict colour appears only on the selected
 * one - so the card shows its decision without shouting the available ones.
 */
function ActionToggle({
  verdict,
  label,
  icon,
  active,
  restingClass,
  activeClass,
  onClick,
}: {
  verdict: DecisionVerdict;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  /** Outline state: semantic border and label, tinted on hover. */
  restingClass: string;
  /** Colour applied only while this verdict is the recorded one. */
  activeClass: string;
  onClick: (verdict: DecisionVerdict) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`${label} this finding`}
      onClick={() => onClick(verdict)}
      className={
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ' +
        (active ? activeClass + ' ' : restingClass)
      }
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * One finding in the review stream.
 *
 * Laid out as an author card rather than a table row: avatar and identity
 * header, category pill, the target/actual comparison, the plain-English
 * review, then the reviewer thread and the sign-off controls.
 */
export default function FindingCard({
  check,
  index,
  selected,
  beaconActive,
  shouldScroll,
  decision,
  comments,
  reviewer,
  receivedAt,
  draft,
  onDraftChange,
  onSelect,
  onDecide,
  onClearDecision,
  onAddComment,
  onDeleteComment,
  participants,
  onRoleChange,
  onLook,
}: {
  check: CheckItem;
  index: number;
  /**
   * Whether this is the finding the 3D view is currently showing.
   *
   * Distinct from `selected`, which means "the selected part carries this
   * finding". Clicking a beacon selects a part that can hold several findings,
   * so every card for that part would otherwise light up and none of them would
   * say which one the marker was actually pointing at.
   */
  beaconActive: boolean;
  selected: boolean;
  shouldScroll: boolean;
  decision: Decision | null;
  comments: ReviewComment[];
  reviewer: Reviewer;
  /** ISO timestamp the audit response landed; the card header's only real clock. */
  receivedAt: string;
  /**
   * The in-progress comment text. Controlled by the parent so it survives this
   * card being filtered out of view and remounted - see ReviewStream.
   */
  draft: string;
  onDraftChange: (value: string) => void;
  onSelect: () => void;
  onDecide: (verdict: DecisionVerdict) => void;
  onClearDecision: () => void;
  onAddComment: (body: string) => void;
  onDeleteComment: (id: string) => void;
  /**
   * Every name that has posted in the discussion, across all findings.
   *
   * The participation count is a property of the session, not of this thread,
   * so it cannot be derived from `comments` - which holds one finding's slice.
   */
  participants: string[];
  /** Switch the identity this client posts as, for the multi-user demo. */
  onRoleChange: (role: string) => void;
  /** Fly the 3D camera to a pose another user attached to their comment. */
  onLook: (viewpoint: Viewpoint) => void;
}) {
  const failed = check.status === 'FAIL';
  const cardRef = useRef<HTMLLIElement>(null);
  const [threadOpen, setThreadOpen] = useState(comments.length > 0);
  /**
   * Whether the body is showing.
   *
   * A failing check opens by default - it is the reason the review exists - and
   * a passing one starts as a single line, because a clean audit is mostly
   * passes and expanded they bury the failures. Either way the reader can
   * override it; this is a default, not a lock.
   */
  const [open, setOpen] = useState(failed);

  // A finding targeted from the 3D view is expanded regardless of its status:
  // the reviewer asked to read this one, and a pin that scrolls to a collapsed
  // single line has not answered them. The status default still applies
  // whenever the card simply sits in the stream.
  useEffect(() => {
    if (beaconActive) setOpen(true);
  }, [beaconActive]);

  // A finding that flips status (a re-run against an edited spec) should follow
  // its new verdict rather than keep the previous default.
  useEffect(() => {
    if (!beaconActive) setOpen(failed);
  }, [failed, beaconActive]);

  // Guarded because scrollIntoView is absent in some test/jsdom environments.
  useEffect(() => {
    if (!selected || !shouldScroll) return;
    cardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [selected, shouldScroll, beaconActive]);

  // Open the thread when it gains its first comment, so posting one updates the
  // view without a second click. Closing it stays the reader's choice.
  useEffect(() => {
    if (comments.length > 0) setThreadOpen(true);
  }, [comments.length]);

  const review = useMemo(() => parsePlainReview(check.comment), [check.comment]);
  const category = useMemo(() => categorise(check), [check]);
  const severity = useMemo(() => severityOf(check), [check]);

  const summaryText = findingSummary(check, review);

  return (
    <li
      ref={cardRef}
      data-beacon-active={beaconActive || undefined}
      data-severity={severity}
      className={
        'animate-fade-in overflow-hidden rounded-xl border bg-white transition ' +
        // The finding the 3D view is showing. It gets the stronger ring plus a
        // tinted ground, so it stays distinguishable from the other cards for
        // the same part - which is the whole reason this is separate from
        // `selected`, and why the card on screen is never ambiguous.
        (beaconActive
          ? 'bg-blue-50/60 ring-2 ring-blue-600 '
          : selected
            ? 'ring-1 ring-blue-600 '
            : '') +
        'border-slate-200 border-l-4 hover:border-slate-300'
      }
      // The severity band drives the accent, so the four levels the review
      // actually distinguishes are visible at a glance down the feed. It was
      // previously a two-way split on `failed`, which rendered an advisory
      // finding and a measured clash identically - the two things this card
      // most needs to keep apart.
      style={{ borderLeftColor: SEVERITY_COLOR[severity] }}
    >
      {/* ------------------------------- Title row -------------------------------
          The whole row toggles the card, so the click target is the card's own
          heading rather than a small chevron. The part button stops propagation
          and keeps its own job (select the solid in the 3D view). */}
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <ChevronRight
            aria-hidden
            className={
              'mt-[3px] h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ' +
              (open ? 'rotate-90' : '')
            }
          />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium leading-snug text-slate-800">
              {check.check_name}
            </span>
            {/* Collapsed, the line still has to carry the verdict: what was
                measured for a pass ("… 110 × 110 × 110 mm — OK"), and the reason
                for a failure, which the status pill alone cannot give. */}
            {!open && (
              <span
                className={
                  'mt-0.5 block truncate text-[11px] ' +
                  (failed ? 'text-rose-700' : 'text-slate-500')
                }
                title={failed ? summaryText : check.found}
              >
                {failed ? summaryText : <><span className="tnum">{check.found}</span> &mdash; OK</>}
              </span>
            )}
          </span>
        </button>

        <StatusPill failed={failed} />

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          title="Select this part in the 3D view"
          className="shrink-0 truncate rounded px-1 py-0.5 text-[10px] text-slate-400 transition hover:bg-slate-100 hover:text-blue-700"
        >
          {partLabel(check.part_id)}
        </button>
      </div>

      {/* ------------------------------- Body -------------------------------- */}
      {open && (
        <div className="space-y-2.5 border-t border-slate-100 px-3 py-2.5">
          {/*
            The problem and the action, each under its own label. This is the
            finding's substance and it was previously flattened into one
            unlabelled paragraph by `findingSummary`, which ran the two
            sentences together ("...has to move. Piping team must move...") and
            left the reader to work out where the description ended and the
            instruction began. The labels were always in the response; nothing
            was rendering them.
          */}
          <ReviewBlock rows={review} fallback={summaryText} />

          <MetricRow check={check} />

          {/*
            Which component the finding is about, named in full. The collapsed
            header shows it too, but truncated and only as a jump target; a
            reader working through an open card should not have to infer the
            subject from the title's prose.
          */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium text-slate-600">Component</span>
            <button
              type="button"
              onClick={onSelect}
              title="Select this part in the 3D view"
              className="self-start rounded text-left font-mono text-[11px] text-slate-700 underline-offset-2 transition hover:text-blue-700 hover:underline"
            >
              {partLabel(check.part_id)}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-100 pt-2">
            <SeverityTag severity={severity} />
            <span className={'text-[10px] font-medium ' + CATEGORY_TONE[category]}>
              {category}
            </span>
            <span className="text-[10px] text-slate-400" title={fullTime(receivedAt)}>
              AutoReview · {receivedAt ? relativeTime(receivedAt) : `finding ${index + 1}`}
            </span>
            {decision && (
              <span className="text-[10px] text-slate-500">
                · {verdictLabel(decision.verdict)} by {reviewer.name}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------- Discussion -----------------------------
          The finding's multi-user thread. Collapsed to a single row by default
          so the dock never outweighs the metrics above it - a card carrying
          three findings and a signed-off verdict is already the full width of
          the panel, and an always-open feed would push the sign-off controls
          below the fold on every one of them. */}
      <div className="border-t border-slate-100">
        <DiscussionSummary
          count={comments.length}
          open={threadOpen}
          onToggle={() => setThreadOpen((value) => !value)}
        />

        {threadOpen && (
          <div className="px-3 pb-3">
            <LiveDiscussion
              comments={comments}
              roster={participants}
              reviewer={reviewer}
              draft={draft}
              onDraftChange={onDraftChange}
              onPost={onAddComment}
              onDelete={onDeleteComment}
              onLook={onLook}
              onRoleChange={onRoleChange}
            />
          </div>
        )}
      </div>

      {/* ------------------------- Sign-off controls ------------------------- */}
      <div className="flex flex-wrap items-center gap-0.5 border-t border-slate-100 px-3 py-1">
        <ActionToggle
          verdict="accepted"
          label="Approve"
          icon={<CheckCircle2 className="h-3 w-3" />}
          active={decision?.verdict === 'accepted'}
          restingClass="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
          activeClass="border-emerald-600 bg-emerald-600 text-white"
          onClick={onDecide}
        />
        <ActionToggle
          verdict="rejected"
          label="Reject"
          icon={<XCircle className="h-3 w-3" />}
          active={decision?.verdict === 'rejected'}
          restingClass="border-rose-200 text-rose-700 hover:bg-rose-50"
          activeClass="border-rose-600 bg-rose-600 text-white"
          onClick={onDecide}
        />
        <ActionToggle
          verdict="modified"
          label="Resolve"
          icon={<Wrench className="h-3 w-3" />}
          active={decision?.verdict === 'modified'}
          restingClass="border-amber-200 text-amber-700 hover:bg-amber-50"
          activeClass="border-amber-600 bg-amber-600 text-white"
          onClick={onDecide}
        />

        {decision && (
          <>
            <span
              className="ml-1 hidden text-[10px] text-slate-400 sm:inline"
              title={fullTime(decision.decidedAt)}
            >
              {relativeTime(decision.decidedAt)}
            </span>
            <button
              type="button"
              onClick={onClearDecision}
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              Clear
            </button>
          </>
        )}

        {!decision && failed && (
          <span className="ml-auto text-[10px] text-slate-400">Awaiting review</span>
        )}
      </div>
    </li>
  );
}
