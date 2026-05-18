import { renderToStaticMarkup } from "react-dom/server";

import type { MetricResult, PersistedProgressEvent } from "./metrics";
import type {
  ReportRunDetail,
  ReportSessionDetail,
  ReportSessionSummary,
  ReportTestInSession,
  SessionProfileAggregate,
  SessionTestEntry,
} from "./report-data";
import type { TranscriptTurn } from "./transcript";

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value.toFixed(6)}`;
}

function statusClass(status: string): string {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  if (status === "running") return "warn";
  if (status === "partial") return "warn";
  return "muted";
}

const STYLES = `
:root {
  color-scheme: dark;
  --bg: #070816;
  --panel: rgba(18, 22, 44, 0.78);
  --panel-strong: rgba(26, 32, 62, 0.95);
  --border: rgba(180, 190, 255, 0.16);
  --text: #eef2ff;
  --muted: #9aa6c7;
  --accent: #8b5cf6;
  --accent2: #22d3ee;
  --good: #34d399;
  --warn: #fbbf24;
  --bad: #fb7185;
  --shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(139, 92, 246, 0.42), transparent 34rem),
    radial-gradient(circle at top right, rgba(34, 211, 238, 0.28), transparent 30rem),
    linear-gradient(135deg, #050611 0%, #0b1022 48%, #070816 100%);
}
a { color: inherit; text-decoration: none; }
.shell { max-width: 1280px; margin: 0 auto; padding: 34px; }
.hero { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 24px; }
.eyebrow { color: var(--accent2); text-transform: uppercase; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
h1 { font-size: clamp(34px, 5vw, 64px); line-height: .95; margin: 10px 0; letter-spacing: -0.055em; }
.hero p { color: var(--muted); max-width: 720px; margin: 0; font-size: 16px; }
.pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border); background: rgba(255,255,255,.06); border-radius: 999px; padding: 9px 13px; color: var(--muted); font-size: 13px; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 28px; box-shadow: var(--shadow); backdrop-filter: blur(20px); padding: 28px; }
.empty { padding: 54px; text-align: center; color: var(--muted); }
.session-list { display: grid; gap: 14px; }
.session-card { display: block; padding: 22px 24px; border-radius: 22px; border: 1px solid var(--border); background: rgba(255,255,255,.045); transition: .15s ease; }
.session-card:hover { border-color: rgba(139,92,246,.55); background: rgba(139,92,246,.13); transform: translateY(-1px); }
.session-card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.session-title { font-size: 22px; font-weight: 800; letter-spacing: -.03em; word-break: break-word; }
.session-sub { color: var(--muted); font-size: 13px; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.session-meta { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; color: var(--muted); font-size: 13px; }
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.usage-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.profile-cards { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.stat { padding: 18px; border-radius: 22px; background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.035)); border: 1px solid var(--border); }
.stat.linked { transition: .15s ease; cursor: pointer; }
.stat.linked:hover { border-color: rgba(139,92,246,.55); background: linear-gradient(180deg, rgba(139,92,246,.18), rgba(34,211,238,.08)); transform: translateY(-1px); }
.label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; font-weight: 800; }
.value { margin-top: 8px; font-size: 30px; font-weight: 900; letter-spacing: -.04em; }
.stat .sub { margin-top: 6px; color: var(--muted); font-size: 12px; }
.section { margin-top: 20px; padding: 24px; border-radius: 24px; background: rgba(0,0,0,.18); border: 1px solid var(--border); }
.section h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: -.03em; }
.section-subtle { color: var(--muted); font-size: 13px; margin-top: -6px; margin-bottom: 14px; }
.crumbs { color: var(--muted); font-size: 13px; margin-bottom: 14px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.crumbs a { border-bottom: 1px dotted rgba(180,190,255,.32); }
.crumbs a:hover { color: var(--accent2); border-color: var(--accent2); }
.run-heading { font-size: 32px; margin: 0 0 6px; letter-spacing: -.04em; }
.run-heading-meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 13px; margin-bottom: 22px; }
.run-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 16px; }
th, td { padding: 13px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
tr:last-child td { border-bottom: 0; }
tr.linked:hover { background: rgba(139,92,246,.08); cursor: pointer; }
td .row-link { display: block; }
.score { font-weight: 900; font-variant-numeric: tabular-nums; }
.good { color: var(--good); }
.warn { color: var(--warn); }
.bad { color: var(--bad); }
.muted { color: var(--muted); }
.status { border: 1px solid currentColor; border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 800; text-transform: uppercase; }
.transcript { display: flex; flex-direction: column; gap: 12px; }
.turn { padding: 14px 16px; border-radius: 18px; border: 1px solid var(--border); background: rgba(255,255,255,.045); }
.turn.assistant { border-color: rgba(34,211,238,.22); }
.turn.simulator { border-color: rgba(139,92,246,.24); }
.turn-head { display: flex; justify-content: space-between; gap: 14px; color: var(--muted); font-size: 12px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .1em; font-weight: 800; }
.turn-body { white-space: pre-wrap; line-height: 1.5; }
pre.log { max-height: 480px; overflow: auto; padding: 16px; border-radius: 16px; background: rgba(0,0,0,.45); border: 1px solid var(--border); color: #dbeafe; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.log-line { display: flex; gap: 12px; padding: 2px 0; }
.log-ts { color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.log-tag { color: var(--accent2); font-weight: 700; flex-shrink: 0; }
.log-msg { color: var(--text); }
@media (max-width: 980px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .shell { padding: 18px; } .cards { grid-template-columns: 1fr; } .hero { display: block; } }
`;

function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${statusClass(status)}`}>{status}</span>;
}

function StatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href?: string;
}) {
  const content = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </>
  );
  if (href) {
    return (
      <a className="stat linked" href={href}>
        {content}
      </a>
    );
  }
  return <div className="stat">{content}</div>;
}

function scoreClass(score: number): string {
  if (score > 0) return "good";
  if (score < 0) return "bad";
  return "muted";
}

function sessionTitle(session: {
  sessionLabel?: string;
  sessionId: string;
}): string {
  return session.sessionLabel ?? session.sessionId;
}

function SessionCard({ session }: { session: ReportSessionSummary }) {
  return (
    <a
      className="session-card"
      href={`/sessions/${encodeURIComponent(session.sessionId)}`}
    >
      <div className="session-card-head">
        <div>
          <div className="session-title">{sessionTitle(session)}</div>
          {session.sessionLabel ? (
            <div className="session-sub">{session.sessionId}</div>
          ) : null}
        </div>
        <StatusBadge status={session.status} />
      </div>
      <div className="session-meta">
        <span>
          <strong>{session.runCount}</strong> run
          {session.runCount === 1 ? "" : "s"}
        </span>
        <span>
          <strong>{session.profileIds.length}</strong> profile
          {session.profileIds.length === 1 ? "" : "s"}{" "}
          <span className="muted">
            ({session.profileIds.join(", ") || "—"})
          </span>
        </span>
        <span>
          <strong>{session.testIds.length}</strong> test
          {session.testIds.length === 1 ? "" : "s"}{" "}
          <span className="muted">({session.testIds.join(", ") || "—"})</span>
        </span>
        <span className={`score ${scoreClass(session.scoreTotal)}`}>
          score {formatNumber(session.scoreTotal)}
        </span>
      </div>
    </a>
  );
}

function IndexPage({ sessions }: { sessions: ReportSessionSummary[] }) {
  return (
    <>
      <header className="hero">
        <div>
          <div className="eyebrow">Personal Intelligence Benchmark</div>
          <h1>Eval report card</h1>
          <p>
            Pick a run to drill into per-profile scores, per-test breakdowns,
            and the full container + runner logs for any single execution.
          </p>
        </div>
        <div className="pill">
          {sessions.length} run{sessions.length === 1 ? "" : "s"} on disk
        </div>
      </header>
      <section className="panel">
        {sessions.length === 0 ? (
          <div className="empty">
            No runs yet. Run <code>evals run --profiles p1,p2 --tests t1</code>{" "}
            first.
          </div>
        ) : (
          <div className="session-list">
            {sessions.map((session) => (
              <SessionCard key={session.sessionId} session={session} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Crumbs({ trail }: { trail: Array<{ href?: string; label: string }> }) {
  return (
    <nav className="crumbs">
      {trail.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`}>
          {index > 0 ? <span className="muted">›</span> : null}{" "}
          {crumb.href ? (
            <a href={crumb.href}>{crumb.label}</a>
          ) : (
            <span>{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function ProfileAggregateCard({
  aggregate,
  href,
}: {
  aggregate: SessionProfileAggregate;
  href?: string;
}) {
  return (
    <StatCard
      label={aggregate.profileId}
      value={formatNumber(aggregate.scoreTotal)}
      sub={`${aggregate.runCount} run${aggregate.runCount === 1 ? "" : "s"} · avg ${formatNumber(aggregate.scoreAverage)}`}
      href={href}
    />
  );
}

function TestRow({
  sessionId,
  entry,
}: {
  sessionId: string;
  entry: SessionTestEntry;
}) {
  const total = entry.profiles.reduce((sum, p) => sum + p.scoreTotal, 0);
  const url = `/sessions/${encodeURIComponent(sessionId)}/tests/${encodeURIComponent(entry.testId)}`;
  return (
    <tr className="linked">
      <td>
        <a href={url} className="row-link">
          <strong>{entry.testId}</strong>
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {entry.profiles.length} profile
          {entry.profiles.length === 1 ? "" : "s"} (
          {entry.profiles.map((p) => p.profileId).join(", ")})
        </a>
      </td>
      <td>
        <a href={url} className={`row-link score ${scoreClass(total)}`}>
          {formatNumber(total)}
        </a>
      </td>
    </tr>
  );
}

function SessionPage({ session }: { session: ReportSessionDetail }) {
  return (
    <>
      <Crumbs
        trail={[
          { href: "/", label: "All runs" },
          { label: sessionTitle(session) },
        ]}
      />
      <h1 className="run-heading">{sessionTitle(session)}</h1>
      <div className="run-heading-meta">
        <StatusBadge status={session.status} />
        {session.sessionLabel ? (
          <span className="run-id">{session.sessionId}</span>
        ) : null}
        <span>{session.runCount} executions</span>
        <span>started {session.startedAt ?? "—"}</span>
      </div>

      <section className="section">
        <h2>Profile scores</h2>
        <p className="section-subtle">
          Total score per profile, summed across every test in this run.
        </p>
        <div className="cards profile-cards">
          {session.profiles.map((aggregate) => (
            <ProfileAggregateCard
              key={aggregate.profileId}
              aggregate={aggregate}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Tests</h2>
        <p className="section-subtle">
          Click a test to compare how each profile performed on it.
        </p>
        <table>
          <thead>
            <tr>
              <th>Test</th>
              <th>Profiles</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {session.tests.map((entry) => (
              <TestRow
                key={entry.testId}
                sessionId={session.sessionId}
                entry={entry}
              />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function ProfileSummaryRow({
  sessionId,
  testId,
  profile,
}: {
  sessionId: string;
  testId: string;
  profile: ReportTestInSession["profiles"][number];
}) {
  const url = `/sessions/${encodeURIComponent(sessionId)}/tests/${encodeURIComponent(testId)}/profiles/${encodeURIComponent(profile.profileId)}`;
  return (
    <tr className="linked">
      <td>
        <a href={url} className="row-link">
          <strong>{profile.profileId}</strong>
        </a>
      </td>
      <td>
        <a href={url} className="row-link">
          <StatusBadge status={profile.status} />
        </a>
      </td>
      <td>
        <a
          href={url}
          className={`row-link score ${scoreClass(profile.scoreTotal)}`}
        >
          {formatNumber(profile.scoreTotal)}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {profile.metricCount}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {profile.transcriptTurns}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {formatCost(profile.totalCostUsd)}
        </a>
      </td>
    </tr>
  );
}

function MetricSummaryTable({
  profiles,
}: {
  profiles: ReportTestInSession["profiles"];
}) {
  // Build a union of metric names across all profiles, ordered by first
  // occurrence so output order stays stable run-to-run.
  const order: string[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    for (const metric of profile.metrics) {
      if (!seen.has(metric.name)) {
        seen.add(metric.name);
        order.push(metric.name);
      }
    }
  }

  if (order.length === 0) {
    return <p className="muted">No metrics recorded yet for this test.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          {profiles.map((profile) => (
            <th key={profile.profileId}>{profile.profileId}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {order.map((name) => (
          <tr key={name}>
            <td>
              <strong>{name}</strong>
            </td>
            {profiles.map((profile) => {
              const metric = profile.metrics.find((m) => m.name === name);
              if (!metric) {
                return (
                  <td key={profile.profileId} className="muted">
                    —
                  </td>
                );
              }
              return (
                <td
                  key={profile.profileId}
                  className={`score ${scoreClass(metric.score)}`}
                >
                  {formatNumber(metric.score, 4)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TestInSessionPage({ test }: { test: ReportTestInSession }) {
  const sessionUrl = `/sessions/${encodeURIComponent(test.sessionId)}`;
  return (
    <>
      <Crumbs
        trail={[
          { href: "/", label: "All runs" },
          { href: sessionUrl, label: test.sessionLabel ?? test.sessionId },
          { label: test.testId },
        ]}
      />
      <h1 className="run-heading">{test.testId}</h1>
      <div className="run-heading-meta">
        <span>
          {test.profiles.length} profile
          {test.profiles.length === 1 ? "" : "s"} compared
        </span>
      </div>

      <section className="section">
        <h2>Profiles</h2>
        <p className="section-subtle">
          Click a profile to inspect its container + test-runner logs.
        </p>
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Status</th>
              <th>Score</th>
              <th>Metrics</th>
              <th>Turns</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {test.profiles.map((profile) => (
              <ProfileSummaryRow
                key={profile.profileId}
                sessionId={test.sessionId}
                testId={test.testId}
                profile={profile}
              />
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>Metric breakdown</h2>
        <p className="section-subtle">
          Per-metric scores side by side across every profile that ran this
          test.
        </p>
        <MetricSummaryTable profiles={test.profiles} />
      </section>
    </>
  );
}

function MetricTable({ metrics }: { metrics: MetricResult[] }) {
  if (metrics.length === 0) {
    return <p className="muted">No metrics recorded for this run yet.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Score</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((metric) => (
          <tr key={metric.name}>
            <td>
              <strong>{metric.name}</strong>
            </td>
            <td className={`score ${scoreClass(metric.score)}`}>
              {formatNumber(metric.score, 4)}
            </td>
            <td>{metric.reason ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Transcript({ turns }: { turns: TranscriptTurn[] }) {
  if (turns.length === 0) {
    return <p className="muted">No transcript turns recorded.</p>;
  }

  return (
    <div className="transcript">
      {turns.map((turn, index) => (
        <article
          key={`${turn.emittedAt}-${index}`}
          className={`turn ${turn.role}`}
        >
          <div className="turn-head">
            <span>{turn.role}</span>
            <span>{turn.emittedAt}</span>
          </div>
          <div className="turn-body">{turn.content}</div>
        </article>
      ))}
    </div>
  );
}

function shortType(event: { message?: { type?: unknown } }): string {
  const type = event.message?.type;
  return typeof type === "string" && type.length > 0 ? type : "event";
}

function ContainerLogs({
  events,
}: {
  events: ReportRunDetail["assistantEvents"];
}) {
  if (events.length === 0) {
    return <p className="muted">No container events recorded.</p>;
  }
  return (
    <pre className="log">
      {events.map((event, index) => (
        <div key={index} className="log-line">
          <span className="log-ts">{event.emittedAt ?? ""}</span>
          <span className="log-tag">{shortType(event)}</span>
          <span className="log-msg">{JSON.stringify(event.message)}</span>
        </div>
      ))}
    </pre>
  );
}

function RunnerLogs({ events }: { events: PersistedProgressEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="muted">
        No runner progress events captured for this run yet.
      </p>
    );
  }
  return (
    <pre className="log">
      {events.map((event, index) => (
        <div key={index} className="log-line">
          <span className="log-ts">{event.emittedAt}</span>
          <span className="log-tag">
            [{event.step}/{event.status}]
          </span>
          <span className="log-msg">
            {event.message}
            {event.detail ? ` — ${event.detail}` : ""}
            {typeof event.turn === "number" ? ` (turn ${event.turn})` : ""}
          </span>
        </div>
      ))}
    </pre>
  );
}

function ExecutionPage({ run }: { run: ReportRunDetail }) {
  const sessionUrl = `/sessions/${encodeURIComponent(run.sessionId)}`;
  const testUrl =
    run.testId !== undefined
      ? `/sessions/${encodeURIComponent(run.sessionId)}/tests/${encodeURIComponent(run.testId)}`
      : sessionUrl;

  const title = `${run.profileId ?? "unknown"} @ ${run.testId ?? "unknown"}`;
  return (
    <>
      <Crumbs
        trail={[
          { href: "/", label: "All runs" },
          { href: sessionUrl, label: run.sessionLabel ?? run.sessionId },
          { href: testUrl, label: run.testId ?? "unknown" },
          { label: run.profileId ?? "unknown" },
        ]}
      />
      <h1 className="run-heading">{title}</h1>
      <div className="run-heading-meta">
        <StatusBadge status={run.status} />
        <span className="run-id">{run.runId}</span>
        <span>started {run.startedAt ?? "—"}</span>
        <span>completed {run.completedAt ?? "—"}</span>
      </div>

      <div className="cards">
        <StatCard label="Score" value={formatNumber(run.scoreTotal)} />
        <StatCard label="Metrics" value={run.metricCount} />
        <StatCard label="Turns" value={run.transcriptTurns} />
        <StatCard label="Cost" value={formatCost(run.totalCostUsd)} />
      </div>

      <section className="section">
        <h2>Metric card</h2>
        <MetricTable metrics={run.metrics} />
      </section>

      <section className="section">
        <h2>Transcript</h2>
        <Transcript turns={run.transcript} />
      </section>

      <section className="section">
        <h2>Container logs</h2>
        <p className="section-subtle">
          Typed event stream emitted by the assistant inside the container.
        </p>
        <ContainerLogs events={run.assistantEvents} />
      </section>

      <section className="section">
        <h2>Test runner logs</h2>
        <p className="section-subtle">
          Step-by-step trace from the eval runner: hatching, setup, simulator
          turns, metric scoring, shutdown.
        </p>
        <RunnerLogs events={run.progressEvents} />
      </section>

      <section className="section">
        <h2>Usage</h2>
        <div className="cards usage-cards">
          <StatCard
            label="Input tokens"
            value={formatNumber(run.totalInputTokens, 0)}
          />
          <StatCard
            label="Output tokens"
            value={formatNumber(run.totalOutputTokens, 0)}
          />
          <StatCard label="Requests" value={run.usage.requests.length} />
        </div>
      </section>
    </>
  );
}

function NotFoundPage({ message }: { message: string }) {
  return (
    <>
      <Crumbs trail={[{ href: "/", label: "All runs" }]} />
      <h1 className="run-heading">Not found</h1>
      <p className="muted">{message}</p>
    </>
  );
}

export type ReportPageInput =
  | { kind: "index"; sessions: ReportSessionSummary[] }
  | { kind: "session"; session: ReportSessionDetail }
  | { kind: "test"; test: ReportTestInSession }
  | { kind: "execution"; run: ReportRunDetail }
  | { kind: "not-found"; message: string };

function pageTitle(input: ReportPageInput): string {
  switch (input.kind) {
    case "index":
      return "Vellum Evals Report Card";
    case "session":
      return `Run · ${sessionTitle(input.session)}`;
    case "test":
      return `Test · ${input.test.testId}`;
    case "execution":
      return `Execution · ${input.run.profileId ?? ""} @ ${input.run.testId ?? ""}`;
    case "not-found":
      return "Not found · Vellum Evals";
  }
}

function PageBody({ input }: { input: ReportPageInput }) {
  switch (input.kind) {
    case "index":
      return <IndexPage sessions={input.sessions} />;
    case "session":
      return <SessionPage session={input.session} />;
    case "test":
      return <TestInSessionPage test={input.test} />;
    case "execution":
      return <ExecutionPage run={input.run} />;
    case "not-found":
      return <NotFoundPage message={input.message} />;
  }
}

function ReportDocument({ input }: { input: ReportPageInput }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{pageTitle(input)}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <div className="shell">
          <PageBody input={input} />
        </div>
      </body>
    </html>
  );
}

export function renderReportPage(input: ReportPageInput): string {
  return `<!doctype html>${renderToStaticMarkup(<ReportDocument input={input} />)}`;
}
