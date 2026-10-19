'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Layers,
  MessageSquare,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  CheckItem,
  CheckStatus,
  CommentMap,
  DecisionMap,
  DecisionVerdict,
  FindingCategory,
  FindingSeverity,
  Reviewer,
  ReviewComment,
  Viewpoint,
} from '@/types/audit';
import { partLabel } from '@/types/audit';
import { decisionKey } from '@/lib/decisions';
import {
  categorise,
  categoryStyle,
  SEVERITY_COLOR,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  severityOf,
} from '@/lib/review';
import FindingCard from '@/components/FindingCard';

/** Which findings the filter shows. */
type FilterKey = 'all' | 'attention' | 'reviewed' | 'commented';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All findings' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'reviewed', label: 'Signed off' },
  { key: 'commented', label: 'With comments' },
];

/** One row of the panel's header, with the item counter badge. */
function HeaderBanner({
  suggestions,
  failures,
  onJumpToFailure,
}: {
  suggestions: number;
  failures: number;
  onJumpToFailure: () => void;
}) {
  const [open, setOpen] = useState(true);

  if (suggestions === 0) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-slate-700">
            AutoReview has no suggestions
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">
            Every requirement in the specification is satisfied by the measured
            geometry.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-blue-200 bg-blue-50">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 p-2.5 text-left transition hover:bg-blue-100/60"
      >
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium text-blue-900">
            AutoReview has found {suggestions} suggestion
            {suggestions === 1 ? '' : 's'}
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-blue-900/70">
            {failures > 0
              ? `${failures} requirement${failures === 1 ? '' : 's'} not met by the model.`
              : 'All requirements are met; the notes below are advisory.'}
          </p>
        </div>
        <ChevronDown
          className={
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600 transition-transform ' +
            (open ? '' : '-rotate-90')
          }
        />
      </button>

      {open && failures > 0 && (
        <div className="border-t border-blue-200 px-2.5 py-1.5">
          <button
            type="button"
            onClick={onJumpToFailure}
            className="text-[10px] font-medium text-blue-600 transition hover:text-blue-800"
          >
            Show the {failures} finding{failures === 1 ? '' : 's'} needing attention
          </button>
        </div>
      )}
    </div>
  );
}

/** The search box and the filter menu that sit under the panel title. */
function FilterBar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  counts,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  filter: FilterKey;
  onFilterChange: (value: FilterKey) => void;
  counts: Record<FilterKey, number>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const active = FILTERS.find((entry) => entry.key === filter) ?? FILTERS[0];

  return (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search findings…"
          aria-label="Search findings"
          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-[11px] text-slate-700 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
        />
      </div>

      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Filter: ${active.label}`}
          className={
            'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-medium transition ' +
            (filter === 'all'
              ? 'border-slate-300 text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              : 'border-blue-600/40 bg-blue-50 text-blue-700')
          }
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {filter === 'all' ? 'Filter' : active.label}
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="animate-fade-in absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl shadow-slate-900/10"
          >
            {FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  onFilterChange(entry.key);
                  setMenuOpen(false);
                }}
                className={
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition ' +
                  (entry.key === filter
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900')
                }
              >
                <span className="flex-1">{entry.label}</span>
                <span className="font-mono text-[10px] text-slate-500">
                  {counts[entry.key]}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The AutoReview and Feedback stream.
 *
 * Replaces the old inspection checklist: the same findings, but presented as a
 * review feed a reader can search, filter, comment on and sign off, rather than
 * a table of rows.
 *
 * Filtering and search are applied to the ORIGINAL index, not the filtered
 * position, because the decision and comment keys are derived from that index
 * (see `decisionKey`). Re-indexing the filtered list would silently reattach
 * every sign-off and comment to the wrong finding.
 */
export default function ReviewStream({
  checks,
  decisions,
  comments,
  reviewer,
  selectedPartId,
  selectedCheckIndex,
  shouldScroll,
  summary,
  solidCount,
  hiddenCount,
  isolatedLabel,
  receivedAt,
  onSelectPart,
  onDecide,
  onClearDecision,
  onAddComment,
  onDeleteComment,
  onOpenReviewerSettings,
  onClose,
  participants,
  onRoleChange,
  onLook,
}: {
  checks: CheckItem[];
  decisions: DecisionMap;
  comments: CommentMap;
  reviewer: Reviewer;
  selectedPartId: string | null;
  /**
   * Index of the finding the 3D view is showing, or null.
   *
   * The part alone cannot say which card the marker meant: a beacon anchors to
   * a defect coordinate, and one part can carry several findings at different
   * points. This is what lets a beacon scroll to and highlight the one card it
   * actually points at, rather than to every finding on that part.
   */
  selectedCheckIndex: number | null;
  shouldScroll: boolean;
  summary: string;
  solidCount: number;
  hiddenCount: number;
  isolatedLabel: string | null;
  /**
   * ISO timestamp of when the audit response landed.
   *
   * The API carries no per-finding timestamp, so this is the card header's only
   * truthful reference point for "when was this raised". Empty when an audit was
   * restored from a cached response.
   */
  receivedAt: string;
  onSelectPart: (partId: string) => void;
  onDecide: (check: CheckItem, index: number, verdict: DecisionVerdict) => void;
  onClearDecision: (check: CheckItem, index: number) => void;
  onAddComment: (check: CheckItem, index: number, body: string) => void;
  onDeleteComment: (check: CheckItem, index: number, id: string) => void;
  onOpenReviewerSettings: () => void;
  onClose: () => void;
  /**
   * Every name that has posted in the discussion, across the whole session.
   *
   * Threaded down to each card's discussion dock so it can say how many other
   * people are in the room. Computed in the workbench rather than here because
   * it spans every finding's thread, not just the ones passing the filter.
   */
  participants: string[];
  /** Switch the identity this client posts as, for the multi-user demo. */
  onRoleChange: (role: string) => void;
  /** Fly the 3D camera to a pose another user attached to their comment. */
  onLook: (viewpoint: Viewpoint) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  /** Which of the panel's two views is showing. */
  const [view, setView] = useState<'findings' | 'severity'>('findings');
  /**
   * In-progress comment text, keyed by check identity.
   *
   * Held here rather than inside FindingCard because the card unmounts whenever
   * a search or filter hides it, which would silently discard a half-written
   * comment the moment the reviewer searched for another finding to check their
   * wording against. A draft is not worth persisting across sessions, but it
   * must survive a keystroke in the search box.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const bodyRef = useRef<HTMLDivElement>(null);

  const setDraft = useCallback((key: string, value: string) => {
    setDrafts((current) => {
      if (value) return { ...current, [key]: value };
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  /** Findings paired with their original index, so keys stay stable. */
  const indexed = useMemo(
    () => checks.map((check, index) => ({ check, index })),
    [checks],
  );

  const reviewed = useMemo(
    () => new Set(checkedIndices(indexed, decisions)),
    [indexed, decisions],
  );

  const failures = useMemo(
    () => checks.filter((check) => check.status === 'FAIL').length,
    [checks],
  );

  /** Findings carrying at least one reviewer comment. */
  const commentedCount = useMemo(
    () =>
      indexed.filter(
        ({ check, index }) => (comments[decisionKey(check, index)] ?? []).length > 0,
      ).length,
    [indexed, comments],
  );

  const counts = useMemo<Record<FilterKey, number>>(
    () => ({
      all: indexed.length,
      attention: failures,
      reviewed: reviewed.size,
      commented: commentedCount,
    }),
    [indexed, failures, reviewed, commentedCount],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return indexed.filter(({ check, index }) => {
      const key = decisionKey(check, index);
      // A finding with an unsent draft is always shown, whatever the filter or
      // search says. Hiding it would strand the draft in a card the reviewer
      // cannot reach, which is the same data loss the draft state was lifted
      // here to prevent.
      if ((drafts[key] ?? '').trim()) return true;

      if (filter === 'attention' && check.status !== 'FAIL') return false;
      if (filter === 'reviewed' && !reviewed.has(index)) return false;
      if (filter === 'commented' && (comments[key] ?? []).length === 0) return false;
      if (!needle) return true;

      const haystack = [
        check.check_name,
        check.expected,
        check.found,
        check.comment ?? '',
        check.fix_instruction,
        check.part_id,
        categorise(check),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [indexed, filter, query, reviewed, comments, drafts]);

  /** Findings with an unsent draft, so the panel can warn they are pinned. */
  const draftCount = useMemo(
    () => indexed.filter(({ check, index }) => (drafts[decisionKey(check, index)] ?? '').trim()).length,
    [indexed, drafts],
  );

  const jumpToFailures = useCallback(() => {
    setFilter('attention');
    setQuery('');
    bodyRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------- Header -------------------------------
          A tab strip over two views of the same audit: the findings in full,
          and a roll-up by severity.

          There is no panel title here. The dock above already renders
          "Feedback & AutoReview" with its count as a tab, and repeating both
          directly beneath it was the loudest thing in the panel while saying
          nothing new. What is left is the state the tab bar cannot show. */}
      <div className="shrink-0 border-b border-slate-200 bg-white">
        <div role="tablist" aria-label="Finding view" className="flex items-center gap-1 px-3 pt-2">
          {(
            [
              { key: 'findings', label: 'Findings', count: checks.length },
              { key: 'severity', label: 'Severity', count: failures },
            ] as const
          ).map(({ key, label, count }) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(key)}
                className={
                  'flex items-center gap-1.5 border-b-2 px-2.5 pb-1.5 pt-1 text-[11px] font-semibold transition ' +
                  (active
                    ? 'border-blue-700 text-blue-800'
                    : 'border-transparent text-slate-500 hover:text-slate-800')
                }
              >
                {label}
                <span
                  className={
                    'rounded-full px-1.5 py-0.5 font-mono text-[10px] font-bold ' +
                    (active ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-500')
                  }
                >
                  {count}
                </span>
              </button>
            );
          })}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close feedback panel"
              className="mb-1 ml-auto shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* The filter bar belongs to the findings list only: the severity view
            is already an aggregate, and filtering it by "needs attention" or a
            search string would leave the counts meaning nothing. */}
        <div className="space-y-2.5 p-3 pt-2.5">
          {(hiddenCount > 0 || isolatedLabel) && (
            <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
              <Layers className="h-3 w-3 shrink-0 text-slate-400" />
              {solidCount} solid{solidCount === 1 ? '' : 's'}
              {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
              {isolatedLabel && ` · isolating ${isolatedLabel}`}
            </p>
          )}

          {view === 'findings' && (
            <>
              <FilterBar
                query={query}
                onQueryChange={setQuery}
                filter={filter}
                onFilterChange={setFilter}
                counts={counts}
              />

              <HeaderBanner
                suggestions={checks.length}
                failures={failures}
                onJumpToFailure={jumpToFailures}
              />
            </>
          )}

          {view === 'findings' && draftCount > 0 && (
            <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-400">
              <MessageSquare className="mt-px h-3 w-3 shrink-0" />
              <span>
                {draftCount} unsent {draftCount === 1 ? 'draft is' : 'drafts are'} kept
                visible until posted, whatever the search or filter.
              </span>
            </p>
          )}
        </div>
      </div>

      {/* -------------------------------- Body -------------------------------- */}
      <div ref={bodyRef} className="thin-scroll min-h-0 flex-1 space-y-2 overflow-y-auto bg-slate-50 p-2.5">
        {view === 'severity' ? (
          <SeverityView checks={checks} onOpenFinding={onSelectPart} />
        ) : checks.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-xs leading-relaxed text-slate-600">
            {summary}
          </p>
        ) : visible.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white p-4 text-center">
            <p className="text-xs text-slate-600">No findings match this view.</p>
            <button
              type="button"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
              className="mt-2 text-[11px] font-medium text-blue-700 transition hover:text-blue-900"
            >
              Clear search and filter
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map(({ check, index }) => {
              const key = decisionKey(check, index);
              return (
                <FindingCard
                  key={check.part_id + '-' + check.check_name + '-' + index}
                  check={check}
                  index={index}
                  selected={check.part_id === selectedPartId}
                  beaconActive={index === selectedCheckIndex}
                  shouldScroll={shouldScroll}
                  decision={decisions[key] ?? null}
                  comments={comments[key] ?? []}
                  reviewer={reviewer}
                  receivedAt={receivedAt}
                  draft={drafts[key] ?? ''}
                  onDraftChange={(value) => setDraft(key, value)}
                  onSelect={() => onSelectPart(check.part_id)}
                  onDecide={(verdict) => onDecide(check, index, verdict)}
                  onClearDecision={() => onClearDecision(check, index)}
                  onAddComment={(body) => onAddComment(check, index, body)}
                  onDeleteComment={(id) => onDeleteComment(check, index, id)}
                  participants={participants}
                  onRoleChange={onRoleChange}
                  onLook={onLook}
                />
              );
            })}
          </ul>
        )}
      </div>

      {/* ------------------------------- Footer ------------------------------- */}
      <div className="flex shrink-0 items-center gap-2 border-t border-slate-200 bg-white px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <button
          type="button"
          onClick={onOpenReviewerSettings}
          className="min-w-0 truncate text-[11px] text-slate-500 transition hover:text-slate-800"
          title="Change the reviewer name on your comments"
        >
          Commenting as <span className="font-medium text-slate-700">{reviewer.name}</span>
        </button>
        <span className="tnum ml-auto shrink-0 text-[10px] text-slate-400">
          {reviewed.size}/{checks.length} signed off
        </span>
      </div>
    </div>
  );
}

/** Indices of findings that carry a sign-off decision. */
function checkedIndices(
  indexed: { check: CheckItem; index: number }[],
  decisions: DecisionMap,
): number[] {
  return indexed
    .filter(({ check, index }) => Boolean(decisions[decisionKey(check, index)]))
    .map(({ index }) => index);
}

/**
 * One part's worth of findings, rolled up by severity.
 *
 * This is what the `Severity` tab shows, and it is deliberately NOT a second
 * listing of the same findings. Two tabs over one list is the redundancy the
 * panel is already carrying too much of; what a reviewer wants from a severity
 * view is which *parts* are in trouble and how badly, so they can decide where
 * to look first without reading twenty-one cards to find out.
 *
 * Each row is one part: its worst band, and how many findings sit at it. Bands
 * run worst-first, then parts within a band by finding count, so the top of the
 * list is the thing to open.
 */
function SeverityView({
  checks,
  onOpenFinding,
}: {
  checks: CheckItem[];
  onOpenFinding: (partId: string) => void;
}) {
  const groups = useMemo(() => {
    const byPart = new Map<string, { severities: FindingSeverity[]; indices: number[] }>();
    checks.forEach((check, index) => {
      const entry = byPart.get(check.part_id) ?? { severities: [], indices: [] };
      entry.severities.push(severityOf(check));
      entry.indices.push(index);
      byPart.set(check.part_id, entry);
    });

    return [...byPart.entries()]
      .map(([partId, entry]) => {
        // The worst band the part carries. SEVERITY_ORDER is worst-first, so
        // the first match is the one to lead with.
        const worst =
          SEVERITY_ORDER.find((band) => entry.severities.includes(band)) ?? 'clear';
        return { partId, worst, count: entry.indices.length, indices: entry.indices };
      })
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.worst) - SEVERITY_ORDER.indexOf(b.worst) ||
          b.count - a.count ||
          a.partId.localeCompare(b.partId),
      );
  }, [checks]);

  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600">
        No findings to group.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {groups.map((group) => (
        <li key={group.partId}>
          <button
            type="button"
            onClick={() => onOpenFinding(group.partId)}
            className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-slate-300 hover:bg-slate-50"
            // The accent is the part's worst band, so the list reads as a
            // priority order at a glance rather than only when read.
            style={{ borderLeft: `4px solid ${SEVERITY_COLOR[group.worst]}` }}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700">
              {partLabel(group.partId)}
            </span>
            <span
              className="shrink-0 text-[10px] font-medium"
              style={{ color: SEVERITY_COLOR[group.worst] }}
            >
              {SEVERITY_LABEL[group.worst]}
            </span>
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-600">
              {group.count}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
