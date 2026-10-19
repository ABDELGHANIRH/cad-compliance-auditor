'use client';

import { initials, partLabel, verdictLabel } from '@/types/audit';
import type { ReportModel } from '@/lib/report';

/**
 * The printable design review summary.
 *
 * Rendered off-screen (see globals.css `#audit-report`) and revealed only for
 * printing, so the browser's own Print / Save-as-PDF produces the document. That
 * keeps the export dependency-free - no PDF library, no native code - while
 * still giving selectable text and real pagination, which a client-side canvas
 * PDF renderer would not.
 *
 * The whole app is dark-themed, so this component deliberately carries its own
 * light palette rather than reusing the slate idiom: printing the dark theme
 * would produce an unreadable black page.
 *
 * The layout mirrors the on-screen review cards - author, category, tags,
 * target/actual, plain-English bullets, then the reviewer thread - so the
 * exported document reads as the same review the reviewer just performed
 * rather than a differently-shaped summary of it.
 */
export default function AuditReport({ report }: { report: ReportModel }) {
  const { progress, clash } = report;
  const passed = report.overallStatus === 'PASS';
  const failedFindings = report.findings.filter((f) => f.check.status === 'FAIL');
  const passedFindings = report.findings.filter((f) => f.check.status !== 'FAIL');

  return (
    <div className="report-doc">
      <header className="report-header">
        <div>
          <h1>{report.title}</h1>
          <p className="report-sub">
            {report.fileName} &middot; {report.solidCount} solid
            {report.solidCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className={`report-verdict ${passed ? 'is-pass' : 'is-fail'}`}>
          {report.overallStatus}
        </div>
      </header>

      {/* ---------------------------- Executive summary ---------------------------- */}
      <section>
        <h2>Executive summary</h2>
        <p className="report-summary">{report.summary}</p>

        <div className="report-stat-row">
          <div className="report-stat">
            <span className="report-stat-value">{report.solidCount}</span>
            <span className="report-stat-label">components inspected</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-value">{report.findings.length}</span>
            <span className="report-stat-label">requirements checked</span>
          </div>
          <div className={`report-stat ${failedFindings.length > 0 ? 'is-fail' : 'is-pass'}`}>
            <span className="report-stat-value">{failedFindings.length}</span>
            <span className="report-stat-label">not met</span>
          </div>
          <div className="report-stat">
            <span className="report-stat-value">{report.commentTotal}</span>
            <span className="report-stat-label">review comments</span>
          </div>
        </div>

        <dl className="report-meta">
          <div>
            <dt>Generated</dt>
            <dd>{new Date(report.generatedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Model file</dt>
            <dd>{report.fileName}</dd>
          </div>
          <div>
            <dt>Reviewed by</dt>
            <dd>
              {report.reviewer.name} &middot; {report.reviewer.role}
            </dd>
          </div>
          <div>
            <dt>Sign-off</dt>
            <dd>
              {progress.reviewed} of {progress.total} findings
              {progress.complete ? '' : ' (incomplete)'}
            </dd>
          </div>
        </dl>

        {report.failedParts.length > 0 && (
          <p className="report-note">
            Components not meeting the specification:{' '}
            <strong>{report.failedParts.map(partLabel).join(', ')}</strong>
          </p>
        )}
      </section>

      {/* --------------------------- Findings needing action --------------------------- */}
      <section>
        <h2>
          {failedFindings.length === 0
            ? 'Findings'
            : `Findings needing action (${failedFindings.length})`}
        </h2>

        {report.findings.length === 0 ? (
          <p className="report-note">
            No conformance checks were performed for this model.
          </p>
        ) : failedFindings.length === 0 ? (
          <p className="report-note">
            Every requirement in the specification is met by the measured
            geometry. The detailed findings follow.
          </p>
        ) : (
          <div className="report-cards">
            {failedFindings.map((finding) => (
              <FindingCard report={finding} key={finding.index} />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------ Passed findings ------------------------------ */}
      {passedFindings.length > 0 && failedFindings.length > 0 && (
        <section>
          <h2>Requirements met ({passedFindings.length})</h2>
          <div className="report-cards">
            {passedFindings.map((finding) => (
              <FindingCard report={finding} key={finding.index} />
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------- Specification ------------------------------- */}
      <section>
        <h2>Specification as submitted</h2>
        <pre className="report-spec">{report.requirements || '(no requirements supplied)'}</pre>
      </section>

      {/* ------------------------------- Clash check -------------------------------- */}
      <section>
        <h2>Geometric interference check</h2>
        <p className="report-note">
          {clash.checked_pairs} component pair
          {clash.checked_pairs === 1 ? '' : 's'} tested. This check is computed
          from the measured geometry rather than inferred, so it does not vary
          between runs.
        </p>
        {clash.interferences.length === 0 ? (
          <p className="report-note">
            No overlapping component sizes were found.
          </p>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th>Component A</th>
                <th>Component B</th>
                <th>Overlap X (mm)</th>
                <th>Overlap Y (mm)</th>
                <th>Overlap Z (mm)</th>
                <th>Penetration (mm)</th>
              </tr>
            </thead>
            <tbody>
              {clash.interferences.map((item, index) => (
                <tr key={index}>
                  <td>{partLabel(item.part_a)}</td>
                  <td>{partLabel(item.part_b)}</td>
                  <td>{item.overlap_mm.x.toFixed(2)}</td>
                  <td>{item.overlap_mm.y.toFixed(2)}</td>
                  <td>{item.overlap_mm.z.toFixed(2)}</td>
                  <td>
                    <strong>{item.penetration_mm.toFixed(2)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {clash.excluded_parts.length > 0 && (
          <p className="report-note">
            Not checked: {clash.excluded_parts.map((e) => partLabel(e.part_id)).join(', ')}.
          </p>
        )}
        {/* Always printed. A size-based test is conservative, and a report that
            presented a clash as a confirmed collision would be overstating what
            was actually measured. */}
        <p className="report-caveat">{clash.caveat}</p>
      </section>

      {/* ------------------------------ Appendix ---------------------------------- */}
      <section>
        <h2>Appendix: measured components</h2>
        <table className="report-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Length X (mm)</th>
              <th>Width Y (mm)</th>
              <th>Height Z (mm)</th>
              <th>Volume (mm&sup3;)</th>
              <th>Hole diameters (mm)</th>
            </tr>
          </thead>
          <tbody>
            {report.components.map((component) => (
              <tr key={component.part_id}>
                <td>{partLabel(component.part_id)}</td>
                <td>{component.dimensions_mm.length_x.toFixed(2)}</td>
                <td>{component.dimensions_mm.width_y.toFixed(2)}</td>
                <td>{component.dimensions_mm.height_z.toFixed(2)}</td>
                <td>{component.volume_mm3.toLocaleString()}</td>
                <td>
                  {component.cylindrical_diameters_mm.length > 0
                    ? component.cylindrical_diameters_mm.join(', ')
                    : /* An empty list means "not measurable for this format",
                         not "no holes" - IFC input never reports diameters. */
                      'not measurable'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="report-footer">
        <p>
          This report is an advisory inspection output. Dimensional verdicts are
          produced by a language model reading measured geometry and are not a
          validated inspection result; the interference check is an
          approximation based on each part&apos;s overall size. Review all
          findings before acting on them.
        </p>
      </footer>
    </div>
  );
}

/** Tailwind classes for a category chip in the printed report. */
function categoryClass(category: string): string {
  switch (category) {
    case 'Safety':
      return 'report-tag is-safety';
    case 'Clearance & Clash':
      return 'report-tag is-clearance';
    case 'Material & Property':
      return 'report-tag is-material';
    case 'Dimensional Compliance':
      return 'report-tag is-dimensional';
    default:
      return 'report-tag';
  }
}

/** One finding, laid out as the review card the screen shows. */
function FindingCard({ report }: { report: ReportModel['findings'][number] }) {
  const { check, decision, review, category, comments } = report;
  const failed = check.status === 'FAIL';

  return (
    <article className={`report-card ${failed ? 'is-fail' : 'is-pass'}`}>
      <div className="report-card-head">
        <span className="report-avatar is-ai">AI</span>
        <div className="report-card-who">
          <span className="report-card-name">AutoReview</span>
          <span className="report-chip">AI Inspector</span>
        </div>
        <span className={`report-status ${failed ? 'is-fail-text' : 'is-pass-text'}`}>
          {check.status}
        </span>
      </div>

      <h3 className="report-card-title">{check.check_name}</h3>

      <div className="report-card-tags">
        <span className={categoryClass(category)}>{category}</span>
        <span className="report-tag is-part">{partLabel(check.part_id)}</span>
        {decision && (
          <span className="report-tag is-decision">{verdictLabel(decision.verdict)}</span>
        )}
      </div>

      <div className="report-metrics">
        <span className="report-metric">
          <span className="report-metric-label">Expected</span>
          <span className="report-metric-value">{check.expected}</span>
        </span>
        <span className={`report-metric ${failed ? 'is-fail' : 'is-pass'}`}>
          <span className="report-metric-label">Found</span>
          <span className="report-metric-value">{check.found}</span>
        </span>
      </div>

      {review.length > 0 && (
        <dl className="report-review">
          {review.map((bullet, index) => (
            <div key={index} className="report-review-row">
              {bullet.label && (
                <dt className={/action/i.test(bullet.label) ? 'is-action' : ''}>
                  {bullet.label}
                </dt>
              )}
              <dd>{bullet.text}</dd>
            </div>
          ))}
        </dl>
      )}

      {comments.length > 0 && (
        <div className="report-thread">
          <p className="report-thread-title">
            Reviewer {comments.length === 1 ? 'comment' : 'comments'}
          </p>
          {comments.map((comment) => (
            <div className="report-comment" key={comment.id}>
              <span className="report-avatar is-reviewer">{initials(comment.author)}</span>
              <div className="report-comment-body">
                <p className="report-comment-meta">
                  <strong>{comment.author}</strong>
                  <span className="report-chip">{comment.role}</span>
                  <span className="report-comment-time">
                    {comment.createdAt
                      ? new Date(comment.createdAt).toLocaleString()
                      : ''}
                  </span>
                </p>
                <p className="report-comment-text">{comment.body}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {decision && (
        <p className="report-card-signoff">
          <strong>{verdictLabel(decision.verdict)}</strong>
          {decision.decidedAt && (
            <> &middot; {new Date(decision.decidedAt).toLocaleString()}</>
          )}
          {decision.notes && <> &middot; {decision.notes}</>}
        </p>
      )}
    </article>
  );
}
