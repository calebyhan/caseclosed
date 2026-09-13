"use client";

import { useEffect, useState } from "react";
import type { CaseDetail } from "../contracts/lifecycle";
import { ReproSpec } from "../contracts/repro";
import { formatDuration, formatTimestamp, StatusBadge } from "./status";

const POLL_INTERVAL_MS = 2_000;

export function CaseDetailView({ initial }: { initial: CaseDetail }) {
  const [detail, setDetail] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const caseId = initial.case.id;
  const live = detail.live;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/cases/${caseId}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as CaseDetail;
        if (!cancelled) {
          setDetail(next);
          setPollError(null);
        }
      } catch (error) {
        if (!cancelled) setPollError(error instanceof Error ? error.message : String(error));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [caseId, live]);

  const { case: header } = detail;
  return (
    <div className="stack">
      <section className="panel">
        <div className="case-title">
          <h1>{header.id}</h1>
          <StatusBadge status={header.status} />
          {live ? <span className="muted small">live · refreshing every 2 s</span> : null}
        </div>
        {pollError ? <p className="error-banner">Live updates failed ({pollError}); showing last loaded state.</p> : null}
        <blockquote className="report">{header.report}</blockquote>
        <dl className="facts">
          <dt>Environment</dt>
          <dd>{header.environment_id}</dd>
          <dt>Created</dt>
          <dd>{formatTimestamp(header.created_at)}</dd>
          <dt>Last change</dt>
          <dd>
            {formatTimestamp(header.updated_at)} ({formatDuration(header.updated_at - header.created_at)} after intake)
          </dd>
          <dt>Source</dt>
          <dd>
            {header.source.type} · channel {header.source.channel_id} · user {header.source.user_id}
          </dd>
        </dl>
        {header.spec_failure ? (
          <div className="callout callout-warn">
            <strong>
              {header.spec_failure.kind === "insufficient"
                ? "Report was not specific enough to test"
                : "Could not build a valid experiment"}
            </strong>
            <ul>
              {header.spec_failure.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <TimelineSection detail={detail} />
      <SpecSection detail={detail} />
      <RunsSection detail={detail} />
      <LinksSection detail={detail} />
      <OperationsSection detail={detail} />
    </div>
  );
}

function TimelineSection({ detail }: { detail: CaseDetail }) {
  return (
    <section className="panel">
      <h2>Timeline</h2>
      <ol className="timeline">
        {detail.timeline.map((entry) =>
          entry.kind === "transition" ? (
            <li key={`t-${entry.id}`} className="timeline-item">
              <span className="nowrap muted small">{formatTimestamp(entry.at)}</span>
              <span>
                {entry.from ? (
                  <>
                    <StatusBadge status={entry.from} /> → <StatusBadge status={entry.to} />
                  </>
                ) : (
                  <StatusBadge status={entry.to} />
                )}
              </span>
              <span className="small">
                {entry.trigger} <code>{entry.event_key}</code>
              </span>
            </li>
          ) : (
            <li key={`r-${entry.id}`} className="timeline-item timeline-rejected">
              <span className="nowrap muted small">{formatTimestamp(entry.at)}</span>
              <span>
                <span className="badge badge-bad">REJECTED</span> {entry.event_type}
                {entry.from_status ? <> in {entry.from_status}</> : null}
              </span>
              <span className="small">
                {entry.reason}
                {entry.event_key ? <> <code>{entry.event_key}</code></> : null}
              </span>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

function SpecSection({ detail }: { detail: CaseDetail }) {
  if (!detail.spec) {
    return (
      <section className="panel">
        <h2>ReproSpec</h2>
        <p className="muted">No ReproSpec has been recorded for this case.</p>
      </section>
    );
  }
  const parsed = ReproSpec.safeParse(detail.spec.spec);
  return (
    <section className="panel">
      <h2>ReproSpec</h2>
      <p className="muted small">
        v{detail.spec.version} · spec <code>{detail.spec.spec_hash.slice(0, 19)}…</code> · AppContext{" "}
        <code>{detail.spec.app_context_hash.slice(0, 19)}…</code> · model {detail.spec.model_id ?? "none recorded"} ·{" "}
        {detail.spec.generation_model_calls} generation call(s)
      </p>
      {parsed.success ? (
        <>
          <p>
            <strong>Goal:</strong> {parsed.data.goal}
          </p>
          <p className="small">
            Start at <code>{parsed.data.environment.start_path}</code> with fixture{" "}
            <code>{parsed.data.environment.fixture}</code>
          </p>
          <h3>Steps</h3>
          <ol>
            {parsed.data.steps.map((step) => (
              <li key={step.id}>
                {step.intent} <span className="muted small">({step.id})</span>
              </li>
            ))}
          </ol>
          <h3>Assertions (all must pass)</h3>
          <ul>
            {parsed.data.assertions.map((assertion) => (
              <li key={assertion.id}>
                <code>{assertion.id}</code> {describeCheck(assertion)}
              </li>
            ))}
          </ul>
          <h3>Failure signals</h3>
          <ul>
            {parsed.data.failure_signals.map((signal) => (
              <li key={signal.id}>
                <code>{signal.id}</code> {describeCheck(signal)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <pre className="code">{JSON.stringify(detail.spec.spec, null, 2)}</pre>
      )}
      {detail.plan ? (
        <>
          <h3>Resolved plan</h3>
          <p className="muted small">
            Promoted from run <code>{detail.plan.source_run_id}</code> · <code>{detail.plan.plan_hash.slice(0, 19)}…</code>
          </p>
          <pre className="code">{JSON.stringify(detail.plan.plan, null, 2)}</pre>
        </>
      ) : null}
    </section>
  );
}

type Check = { type: string } & Record<string, unknown>;

function describeCheck(check: Check): string {
  switch (check.type) {
    case "network_status":
      return `${check.method} ${check.url_contains} → status ${check.min}–${check.max}`;
    case "element_visible":
      return `${check.role} “${check.name}” visible within ${check.within_ms} ms`;
    case "element_not_visible":
      return `${check.role} “${check.name}” not visible within ${check.within_ms} ms`;
    case "element_still_visible_after_ms":
      return `${check.role} “${check.name}” still visible after ${check.after_ms} ms`;
    case "url_contains":
      return `URL contains “${check.value}” within ${check.within_ms} ms`;
    case "text_visible":
      return `text “${check.value}” visible within ${check.within_ms} ms`;
    default:
      return JSON.stringify(check);
  }
}

function RunsSection({ detail }: { detail: CaseDetail }) {
  return (
    <section className="panel">
      <h2>Runs</h2>
      {detail.runs.length === 0 ? <p className="muted">No runs yet.</p> : null}
      <div className="stack">
        {detail.runs.map((run) => (
          <article key={run.id} className="run-card">
            <header className="run-header">
              <strong>{run.run_type}</strong>
              {run.result ? <StatusBadge status={run.result} /> : <span className="badge badge-active">{run.status}</span>}
              <span className="muted small">
                <code>{run.id}</code>
              </span>
            </header>
            <dl className="facts small">
              <dt>Duration</dt>
              <dd>
                {run.started_at !== null && run.finished_at !== null
                  ? formatDuration(run.finished_at - run.started_at)
                  : "in progress"}
              </dd>
              <dt>Commit</dt>
              <dd>{run.commit_sha ? <code>{run.commit_sha}</code> : "—"}</dd>
              <dt>Infra error</dt>
              <dd>{run.infra_error ? run.infra_error_reason : "none"}</dd>
              <dt>Model calls</dt>
              <dd>{run.model_calls}</dd>
              <dt>Plan recovered</dt>
              <dd>{run.plan_recovered ? "yes" : "no"}</dd>
              <dt>Counts</dt>
              <dd>
                {run.assertions_total === null
                  ? "not evaluated"
                  : `${run.assertions_passed}/${run.assertions_total} assertions passed · ${run.signals_matched} signal(s) matched`}
              </dd>
            </dl>
            {run.checks.length > 0 ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>ID</th>
                      <th>Type</th>
                      <th>Expected</th>
                      <th>Observed</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.checks.map((check) => (
                      <tr key={`${check.kind}-${check.assertion_id}`}>
                        <td>{check.kind}</td>
                        <td>
                          <code>{check.assertion_id}</code>
                        </td>
                        <td>{check.type}</td>
                        <td>{check.expected}</td>
                        <td>{check.observed}</td>
                        <td>
                          {check.kind === "assertion"
                            ? check.passed
                              ? "✓ passed"
                              : "✗ failed"
                            : check.passed
                              ? "✓ matched"
                              : "not matched"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted small">No assertion results recorded.</p>
            )}
            {run.actions.length > 0 ? (
              <details>
                <summary>Actions ({run.actions.length})</summary>
                <pre className="code">{JSON.stringify(run.actions, null, 2)}</pre>
              </details>
            ) : null}
            <details>
              <summary>Evidence ({run.evidence.length})</summary>
              {run.evidence.length === 0 ? (
                <p className="muted small">No evidence recorded.</p>
              ) : (
                <ul className="small">
                  {run.evidence.map((item) => (
                    <li key={item.id}>
                      {item.kind} · {item.mime_type} · <code>{item.relative_path}</code>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}

function LinksSection({ detail }: { detail: CaseDetail }) {
  const links = detail.external_links;
  return (
    <section className="panel">
      <h2>External links</h2>
      <dl className="facts">
        <dt>Slack</dt>
        <dd>
          {links?.slack_root_ts ? (
            <>
              thread <code>{links.slack_root_ts}</code> in <code>{links.slack_channel_id}</code>
            </>
          ) : (
            "thread not created yet"
          )}
        </dd>
        <dt>Linear</dt>
        <dd>
          {links?.linear_issue_identifier ? (
            <>
              {links.linear_issue_url ? <a href={links.linear_issue_url}>{links.linear_issue_identifier}</a> : links.linear_issue_identifier}{" "}
              <code>{links.linear_issue_id}</code>
            </>
          ) : (
            "no issue"
          )}
        </dd>
        <dt>GitHub</dt>
        <dd>
          {links?.github_pr_number ? (
            <>
              {links.github_repository}#{links.github_pr_number} @ <code>{links.github_commit_sha}</code>
            </>
          ) : (
            "no fix attempt"
          )}
        </dd>
      </dl>
      {detail.fix_attempts.length > 0 ? (
        <>
          <h3>Fix attempts</h3>
          <ul className="small">
            {detail.fix_attempts.map((attempt) => (
              <li key={attempt.id}>
                {attempt.repository}#{attempt.pr_number} · <code>{attempt.commit_sha}</code> · merged{" "}
                {formatTimestamp(attempt.merged_at)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function OperationsSection({ detail }: { detail: CaseDetail }) {
  return (
    <section className="panel">
      <h2>Operations</h2>
      <h3>Jobs</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Type</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {detail.jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <code>{job.idempotency_key}</code>
                </td>
                <td>{job.type}</td>
                <td>{job.status}</td>
                <td>{job.attempt_count}</td>
                <td>{job.last_error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>External side effects</h3>
      {detail.side_effects.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Idempotency key</th>
                <th>Type</th>
                <th>Status</th>
                <th>External ID</th>
                <th>Attempts</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {detail.side_effects.map((effect) => (
                <tr key={effect.key}>
                  <td>
                    <code>{effect.key}</code>
                  </td>
                  <td>{effect.type}</td>
                  <td>{effect.status}</td>
                  <td>{effect.external_id ?? "—"}</td>
                  <td>{effect.attempt_count}</td>
                  <td>{effect.last_error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
