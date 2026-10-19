import type { CheckItem, Decision, DecisionMap, ReviewProgress } from '@/types/audit';

/**
 * Storage key is versioned. A future change to the Decision shape bumps the
 * suffix so stale entries are ignored rather than misread.
 */
const STORAGE_KEY = 'cad-auditor.decisions.v1';

/**
 * Identity for one finding.
 *
 * `part_id` alone is NOT sufficient: several checks routinely share a part_id -
 * the badge picks one of them with `find(status === 'FAIL') ?? [0]`, which is
 * only possible because duplicates exist. Keying on part_id would make a
 * decision on one finding silently apply to every other finding on that part.
 *
 * This mirrors the React key at the checklist render site. `index` is included
 * because a model can legitimately emit the same check_name twice for the same
 * part, and the index is the only thing that distinguishes those rows.
 *
 * NUL is the separator because it cannot appear in a check_name or part_id
 * coming from the LLM, so no combination of fields can forge another's key.
 */
export function decisionKey(check: CheckItem, index: number): string {
  return `${check.part_id}\u0000${check.check_name}\u0000${index}`;
}

/**
 * The thread key for the audit's team channel.
 *
 * Comments are stored as one `CommentMap` keyed by thread identity, and the
 * team channel is simply another thread - one not attached to any finding. The
 * leading NUL mirrors `decisionKey`'s separator so the key cannot collide with
 * a part id, because no part id can contain a NUL.
 *
 * Keying it on the audit rather than per-run means the channel survives a
 * re-audit, which is the point: a note like "the riser needs checking next
 * time" is about the model, not about one run's findings.
 */
export function teamChannelKey(): string {
  return `\u0000team-chat`;
}

/**
 * Read persisted decisions.
 *
 * Every failure mode returns an empty map rather than throwing: storage can be
 * unavailable entirely (private windows), can hold a value written by an older
 * build, and can have been edited by hand. A demo must load either way.
 */
export function loadDecisions(): DecisionMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: DecisionMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Partial<Decision>;
      if (
        candidate.verdict !== 'accepted' &&
        candidate.verdict !== 'rejected' &&
        candidate.verdict !== 'modified'
      ) {
        continue;
      }
      result[key] = {
        verdict: candidate.verdict,
        notes: typeof candidate.notes === 'string' ? candidate.notes : '',
        decidedAt: typeof candidate.decidedAt === 'string' ? candidate.decidedAt : '',
      };
    }
    return result;
  } catch {
    // Corrupt JSON, storage disabled, or quota/security error on read.
    return {};
  }
}

/** Persist decisions. A failed write is not worth interrupting the review for. */
export function saveDecisions(decisions: DecisionMap): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(decisions).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions));
  } catch {
    // Storage full or unavailable - decisions stay in memory for this session.
  }
}

export function clearDecisions(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Re-key a stored map onto the current response.
 *
 * Decisions are keyed by check identity, which is derived from the audit
 * response. Re-running an audit for the same file produces a fresh set of
 * checks, so a stored map is only meaningful for the response it was made
 * against. This drops any entry whose key does not correspond to a check in
 * `checks`, which is what stops a previous model's decisions leaking onto a new
 * upload that happens to reuse part ids like `part_1`.
 *
 * Returns the filtered map and whether anything was dropped.
 */
export function reconcileDecisions(
  stored: DecisionMap,
  checks: CheckItem[],
): { decisions: DecisionMap; dropped: number } {
  const valid = new Set(checks.map((check, index) => decisionKey(check, index)));
  const kept: DecisionMap = {};
  let dropped = 0;

  for (const [key, decision] of Object.entries(stored)) {
    if (valid.has(key)) kept[key] = decision;
    else dropped += 1;
  }

  return { decisions: kept, dropped };
}

/** Sign-off progress for the banner and the export gate. */
export function reviewProgress(checks: CheckItem[], decisions: DecisionMap): ReviewProgress {
  let accepted = 0;
  let rejected = 0;
  let modified = 0;

  checks.forEach((check, index) => {
    const decision = decisions[decisionKey(check, index)];
    if (!decision) return;
    if (decision.verdict === 'accepted') accepted += 1;
    else if (decision.verdict === 'rejected') rejected += 1;
    else modified += 1;
  });

  const reviewed = accepted + rejected + modified;
  return {
    reviewed,
    total: checks.length,
    accepted,
    rejected,
    modified,
    complete: checks.length > 0 && reviewed === checks.length,
  };
}
