import type {
  AuditResponse,
  CheckItem,
  CommentMap,
  DecisionMap,
  FindingCategory,
  ReviewComment,
  Reviewer,
  ReviewProgress,
} from '@/types/audit';
import { decisionKey, reviewProgress } from '@/lib/decisions';
import { categorise, parsePlainReview } from '@/lib/review';
import { partLabel } from '@/types/audit';

/** Everything the on-screen report and the JSON export both need. */
export interface ReportInput {
  result: AuditResponse;
  decisions: DecisionMap;
  comments: CommentMap;
  /** Who authored the review comments. */
  reviewer: Reviewer;
  /** Uploaded file name, for the report header. */
  fileName: string;
  /** The specification text as submitted. */
  requirements: string;
}

/** One finding, joined with its sign-off and its reviewer thread. */
export interface ReportFinding {
  index: number;
  check: CheckItem;
  decision: DecisionMap[string] | null;
  /** The plain-English review, split into its labelled bullets. */
  review: { label: string; text: string }[];
  category: FindingCategory;
  comments: ReviewComment[];
}

export interface ReportModel {
  title: string;
  generatedAt: string;
  fileName: string;
  requirements: string;
  overallStatus: 'PASS' | 'FAIL';
  summary: string;
  solidCount: number;
  failedParts: string[];
  findings: ReportFinding[];
  progress: ReviewProgress;
  clash: AuditResponse['clash'];
  /** Components with their measured geometry, for the appendix. */
  components: AuditResponse['cad_metrics']['components'];
  /** Who the review comments are attributed to. */
  reviewer: Reviewer;
  /** Total comments across every finding, for the summary block. */
  commentTotal: number;
}

const TITLE = 'Design Review Summary';

/**
 * Flatten the audit response plus sign-off state into one object.
 *
 * Built once and shared by the JSON export and the printable view so the two can
 * never drift - the printed report and the machine-readable file describe the
 * same review.
 */
export function buildReport({
  result,
  decisions,
  comments,
  reviewer,
  fileName,
  requirements,
}: ReportInput): ReportModel {
  const checks = result.audit.checks;

  const findings: ReportFinding[] = checks.map((check, index) => {
    const key = decisionKey(check, index);
    return {
      index,
      check,
      decision: decisions[key] ?? null,
      review: parsePlainReview(check.comment),
      category: categorise(check),
      comments: comments[key] ?? [],
    };
  });

  return {
    title: TITLE,
    // Captured at export time, not at audit time: the report is a record of the
    // review, and the review finishes when the engineer exports it.
    generatedAt: new Date().toISOString(),
    fileName: fileName || 'model',
    requirements,
    overallStatus: result.audit.overall_status,
    summary: result.audit.summary,
    solidCount: result.cad_metrics.solid_count,
    failedParts: result.audit.failed_parts,
    findings,
    progress: reviewProgress(checks, decisions),
    clash: result.clash,
    components: result.cad_metrics.components,
    reviewer,
    commentTotal: findings.reduce((total, finding) => total + finding.comments.length, 0),
  };
}

/** Findings the engineer has not yet dispositioned. */
export function unreviewedFindings(report: ReportModel): ReportFinding[] {
  return report.findings.filter((finding) => finding.decision === null);
}

/**
 * Trigger a browser download of `data` as JSON.
 *
 * The object URL is revoked on the next tick: revoking synchronously can cancel
 * the download in some browsers, while never revoking leaks the blob for the
 * lifetime of the document.
 */
export function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `sample.ifc` + prefix -> `sample.ifc-audit-2026-09-28.json` */
export function reportFileName(fileName: string, extension: string): string {
  const base = (fileName || 'model').replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '_');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-audit-${stamp}.${extension}`;
}

/**
 * Serialise the report for the JSON export.
 *
 * Deliberately flatter and more explicit than the raw API response: it records
 * the engineer's decision alongside each finding, which is the part that makes
 * it a sign-off record rather than a copy of the server's answer.
 */
export function reportToJson(report: ReportModel): Record<string, unknown> {
  const { progress } = report;

  return {
    title: report.title,
    generated_at: report.generatedAt,
    model: {
      file_name: report.fileName,
      solid_count: report.solidCount,
    },
    reviewer: {
      name: report.reviewer.name,
      role: report.reviewer.role,
    },
    requirements: report.requirements,
    verdict: {
      status: report.overallStatus,
      summary: report.summary,
      failed_parts: report.failedParts,
    },
    sign_off: {
      reviewed: progress.reviewed,
      total: progress.total,
      complete: progress.complete,
      accepted: progress.accepted,
      rejected: progress.rejected,
      change_required: progress.modified,
      comment_count: report.commentTotal,
    },
    findings: report.findings.map(({ check, decision, review, category, comments }) => ({
      check_name: check.check_name,
      part_id: check.part_id,
      part_label: partLabel(check.part_id),
      category,
      status: check.status,
      expected: check.expected,
      found: check.found,
      // The plain-English review, kept both as labelled bullets and as the raw
      // text the backend sent, so a downstream reader can use either without
      // re-parsing.
      review: review.map((bullet) => ({ label: bullet.label, text: bullet.text })),
      comment: check.comment ?? '',
      fix_instruction: check.fix_instruction,
      decision: decision
        ? { verdict: decision.verdict, notes: decision.notes, decided_at: decision.decidedAt }
        : null,
      thread: comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        role: comment.role,
        body: comment.body,
        created_at: comment.createdAt,
        // The viewpoint is deliberately still dropped here; the anchor is not.
        // A pose is only replayable inside the viewer, so in a document it is
        // noise. The coordinate is the opposite: it is the one field that makes
        // a comment's location reproducible by a reader who has the model and
        // not the app, which is what a report is for.
        anchor: comment.anchor ?? null,
      })),
    })),
    clash_pre_check: {
      checked_pairs: report.clash.checked_pairs,
      excluded_parts: report.clash.excluded_parts,
      interferences: report.clash.interferences,
      clearances: report.clash.clearances,
      caveat: report.clash.caveat,
    },
    measured_components: report.components.map((component) => ({
      part_id: component.part_id,
      part_label: partLabel(component.part_id),
      dimensions_mm: component.dimensions_mm,
      volume_mm3: component.volume_mm3,
      cylindrical_diameters_mm: component.cylindrical_diameters_mm,
      ifc_class: component.ifc_class ?? null,
      material: component.material ?? null,
    })),
  };
}
