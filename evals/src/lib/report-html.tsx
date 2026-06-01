import { renderToStaticMarkup } from "react-dom/server";

import type {
  CostDiagnostic,
  CostDiagnosticReason,
  CostStatus,
  MetricResult,
  MetricUnit,
  PersistedProgressEvent,
  UsageSummary,
} from "./metrics";
import type {
  DockerArtifactFile,
  ReportRunDetail,
  ReportSessionDetail,
  ReportSessionSummary,
  ReportTestInSession,
  SessionProfileAggregate,
  SessionTestEntry,
  SubprocessLogFile,
} from "./report-data";
import type { TranscriptTurn } from "./transcript";

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatAggregateScore(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value.toFixed(6)}`;
}

/**
 * Render a metric `score` using its declared unit.
 *
 * `MetricResult.unit` defaults to `"fraction"` — the score is a 0-1
 * quality fraction, displayed as `XX.XX%` per Vargas's round-3 evals
 * feedback ("scores rendering as raw numbers, need 0-100% display").
 *
 * `"raw"` opts out — the score carries units that have no meaning as a
 * percent (e.g. `assistant-cost-usd` returns negative dollars). Those
 * fall back to plain number formatting.
 *
 * `undefined` is treated as `"fraction"` so older metric files that
 * don't set the field automatically get the new percent display.
 */
function formatScore(
  score: number,
  unit: MetricUnit | undefined,
  digits = 2,
): string {
  if (unit === "raw") return formatNumber(score, 4);
  return `${(score * 100).toFixed(digits)}%`;
}

function costStatusChip(status: CostStatus | undefined): {
  label: string;
  className: string;
} | null {
  if (!status || status === "ok") return null;
  if (status === "partial") {
    return { label: "Partial pricing", className: "chip warn" };
  }
  return { label: "Cost unavailable", className: "chip bad" };
}

const COST_REASON_LABELS: Record<CostDiagnosticReason, string> = {
  missing_provider:
    "No provider on usage record (adapter didn't include `provider` or `actualProvider`).",
  missing_model: "No `model` on usage record.",
  missing_tokens: "No input/output token counts on usage record.",
  unpriced_model:
    "Provider/model not in the evals pricing table (evals/src/lib/pricing.ts).",
};

function statusClass(status: string): string {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  if (status === "abandoned") return "bad";
  if (status === "running") return "warn";
  if (status === "partial") return "warn";
  return "muted";
}

/**
 * Argv tokens that contain none of these characters render as-is; any
 * token containing one of them is wrapped in single quotes (with any
 * embedded single quote escaped via the `'\''` Bourne idiom). Goal is a
 * copy-pasteable shell command, not a perfect POSIX quoter — the evals
 * CLI's flag values are typically alphanumerics, commas, hex ids, file
 * paths without spaces, so the simple matcher covers the realistic
 * surface without dragging in a dep.
 */
const SHELL_UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

function shellQuoteToken(token: string): string {
  if (token === "") return "''";
  if (!SHELL_UNSAFE.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Reformat a raw `process.argv` snapshot as the canonical `evals …`
 * command an operator would type at a shell.
 *
 * `argv[0]` is the runtime (bun / node) and `argv[1]` is the script
 * path the runtime exec'd — both are env-specific noise once we know
 * the invocation came through `evals run`. We drop them and prepend
 * the canonical CLI name so the rendered line is the same whether the
 * run originated from `bun src/cli.ts run …`, a compiled `evals` shim,
 * or a future macOS bundle. Tokens get shell-quoted so the result is
 * directly paste-runnable.
 *
 * Returns `undefined` when argv is missing or too short to be a real
 * CLI invocation; the caller suppresses the section in that case.
 */
export function formatCliCommand(
  argv: string[] | undefined,
): string | undefined {
  if (!argv || argv.length < 3) return undefined;
  const args = argv.slice(2);
  return ["evals", ...args.map(shellQuoteToken)].join(" ");
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
.cli-command { margin: 0 0 22px; padding: 14px 18px; border: 1px solid var(--border); border-radius: 14px; background: rgba(0,0,0,.32); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; color: #dbeafe; word-break: break-all; }
.cli-command-label { display: block; font-family: inherit; font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .14em; margin-bottom: 6px; font-weight: 800; }
.cli-command code { font-family: inherit; }
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
.chip { display: inline-flex; align-items: center; border: 1px solid currentColor; border-radius: 999px; padding: 2px 10px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; }
.chip.warn { color: var(--warn); }
.chip.bad { color: var(--bad); }
.cost-diag { margin-top: 16px; padding: 16px 18px; border: 1px solid var(--border); border-radius: 18px; background: rgba(255,255,255,.04); }
.cost-diag-head { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
.cost-diag-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cost-diag-table th, .cost-diag-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.cost-diag-table th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; font-weight: 800; }
.debug-section { border: 1px solid rgba(251, 113, 133, .24); background: rgba(251, 113, 133, .06); }
.debug-item { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
.debug-item:last-child { margin-bottom: 0; }
.debug-item code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(0,0,0,.3); padding: 2px 6px; border-radius: 4px; font-size: 12px; flex: 1; overflow: auto; }
.debug-item.bad { color: var(--bad); }
.action-buttons { display: flex; gap: 12px; margin-top: 16px; }
button { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: rgba(255,255,255,.08); color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer; transition: .15s ease; }
button:hover { background: rgba(139,92,246,.18); border-color: rgba(139,92,246,.4); }
button.bad { color: var(--bad); border-color: rgba(251,113,133,.4); }
button.bad:hover { background: rgba(251,113,133,.15); border-color: var(--bad); }
.panel-actions { display: flex; justify-content: flex-end; gap: 12px; margin-bottom: 16px; }
.confirm-action { position: relative; }
.confirm-action > summary { display: inline-block; padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(251,113,133,.4); background: rgba(255,255,255,.08); color: var(--bad); font-size: 13px; font-weight: 600; cursor: pointer; list-style: none; transition: .15s ease; user-select: none; }
.confirm-action > summary::-webkit-details-marker { display: none; }
.confirm-action > summary:hover { background: rgba(251,113,133,.15); border-color: var(--bad); }
.confirm-action[open] > summary { background: rgba(251,113,133,.18); border-color: var(--bad); }
.confirm-form { margin-top: 10px; padding: 14px; border-radius: 10px; border: 1px solid rgba(251,113,133,.35); background: rgba(251,113,133,.06); display: flex; flex-direction: column; gap: 10px; max-width: 480px; }
.confirm-prompt { margin: 0; font-size: 13px; color: var(--text); line-height: 1.5; }
.confirm-prompt code { padding: 1px 6px; border-radius: 4px; background: rgba(0,0,0,.4); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--accent2); }
.confirm-form button[type="submit"] { align-self: flex-start; }
.artifact-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.artifact-list li { padding: 10px 14px; border-radius: 12px; background: rgba(0,0,0,.28); border: 1px solid var(--border); transition: .15s ease; }
.artifact-list li:hover { border-color: rgba(34,211,238,.4); background: rgba(34,211,238,.06); }
.artifact-link { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--accent2); display: inline-flex; align-items: center; gap: 8px; word-break: break-all; }
.artifact-link::before { content: "↗"; opacity: .65; font-size: 12px; }
.artifact-link:hover { color: var(--text); text-decoration: underline; }
.subprocess-log-block { margin-top: 12px; }
.subprocess-log-block:first-child { margin-top: 0; }
.subprocess-log-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 6px; flex-wrap: wrap; }
.subprocess-log-head strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--accent2); }
.subprocess-log-head .raw-link { font-size: 12px; color: var(--muted); }
.subprocess-log-head .raw-link:hover { color: var(--accent2); }
.subprocess-log-empty { color: var(--muted); font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 8px 12px; border-radius: 8px; background: rgba(0,0,0,.25); }
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
          score {formatAggregateScore(session.scoreTotal)}
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
          <>
            <div className="panel-actions">
              <details className="confirm-action">
                <summary className="bad">Delete all non-running</summary>
                <form
                  className="confirm-form"
                  method="post"
                  action="/api/runs/delete-all"
                >
                  <p className="confirm-prompt">
                    This deletes every run on disk that isn&rsquo;t currently
                    running. It cannot be undone.
                  </p>
                  <button className="bad" type="submit">
                    Yes, delete every non-running run
                  </button>
                </form>
              </details>
            </div>
            <div className="session-list">
              {sessions.map((session) => (
                <SessionCard key={session.sessionId} session={session} />
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}

/**
 * Reproduction line shown at the top of the session and run pages.
 *
 * Surfaces the exact `evals …` command that produced the surrounding
 * run/session so an operator can copy-paste it to rerun, share via
 * Slack, or include in a PR description. Renders nothing when the
 * underlying argv is missing (legacy runs predate the field) — the
 * empty case is invisible rather than a "command unknown" placeholder
 * since the rest of the page still tells the story.
 */
function CliCommandSection({ argv }: { argv: string[] | undefined }) {
  const command = formatCliCommand(argv);
  if (!command) return null;
  return (
    <div className="cli-command">
      <span className="cli-command-label">CLI command</span>
      <code>{command}</code>
    </div>
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

function profileRunBreakdown(aggregate: SessionProfileAggregate): string {
  const parts: string[] = [
    `${aggregate.runCount} run${aggregate.runCount === 1 ? "" : "s"}`,
  ];
  if (aggregate.completedCount > 0) {
    parts.push(`${aggregate.completedCount} completed`);
  }
  if (aggregate.failedCount > 0) {
    parts.push(`${aggregate.failedCount} failed`);
  }
  if (aggregate.runningCount > 0) {
    parts.push(`${aggregate.runningCount} running`);
  }
  return parts.join(" · ");
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
      value={formatAggregateScore(aggregate.scoreTotal)}
      sub={profileRunBreakdown(aggregate)}
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
        <a
          href={url}
          className={`row-link score ${scoreClass(entry.scoreTotal)}`}
        >
          {formatAggregateScore(entry.scoreTotal)}
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

      <CliCommandSection argv={session.cliArgv} />

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
          {formatAggregateScore(profile.scoreTotal)}
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
                  {formatScore(metric.score, metric.unit, 2)}
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
              {formatScore(metric.score, metric.unit, 2)}
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
  emptyLabel = "No container events recorded.",
}: {
  events: ReportRunDetail["assistantEvents"];
  /**
   * Override the "no events" copy so the ingest section can read as
   * "no memory-formation events" instead of the question-turn default.
   */
  emptyLabel?: string;
}) {
  if (events.length === 0) {
    return <p className="muted">{emptyLabel}</p>;
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

/**
 * One parsed entry from a subprocess log file. `ts` and `tag` and
 * `glyph` are set when the line matched the canonical
 * `[YYYY-MM-DD HH:MM:SS] [step]  glyph  msg` shape; otherwise `raw`
 * carries the line verbatim and the structured fields stay undefined
 * so the renderer can fall back to a single uncolored column.
 */
interface ParsedSubprocessLogLine {
  ts?: string;
  tag?: string;
  glyph?: string;
  message?: string;
  raw: string;
}

/**
 * Regex matching the `formatSubprocessLogLine` output:
 *
 *   [YYYY-MM-DD HH:MM:SS] [step      ] glyph rest-of-line
 *
 * The step slot is space-padded so we tolerate any run of whitespace
 * between `]` and the glyph. `glyph` is a single non-space symbol
 * (`•` or `✗`) followed by exactly one space, then the message.
 */
const SUBPROCESS_LINE_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([^\]]+)\]\s+(\S+)\s(.*)$/;

/**
 * Parse the raw contents of a subprocess log into one entry per line,
 * preserving order. Trailing blank line (from the `join("\n") + "\n"`
 * the writer emits) is dropped so the UI doesn't render an empty row.
 * Lines that don't match the canonical shape (legacy `[STDOUT]` /
 * `[STDERR]` artifacts, child processes that wrote ANSI control
 * sequences, …) fall through with `raw` set so they're still visible.
 *
 * Exported for tests.
 */
export function parseSubprocessLog(content: string): ParsedSubprocessLogLine[] {
  if (content.length === 0) return [];
  const rows = content.split("\n");
  if (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows.map((raw) => {
    const match = SUBPROCESS_LINE_RE.exec(raw);
    if (!match) return { raw };
    return {
      ts: match[1],
      tag: match[2],
      glyph: match[3],
      message: match[4],
      raw,
    };
  });
}

function SubprocessLog({ log }: { log: SubprocessLogFile }) {
  const lines = parseSubprocessLog(log.content);
  if (lines.length === 0) {
    return <div className="subprocess-log-empty">(empty)</div>;
  }
  return (
    <pre className="log">
      {lines.map((line, index) => {
        if (line.ts === undefined) {
          // Unparsable line — render in one column so a legacy
          // `[STDOUT] foo` artifact still shows up.
          return (
            <div key={index} className="log-line">
              <span className="log-msg">{line.raw}</span>
            </div>
          );
        }
        return (
          <div key={index} className="log-line">
            <span className="log-ts">{line.ts}</span>
            <span className="log-tag">
              [{line.tag}/{line.glyph}]
            </span>
            <span className="log-msg">{line.message}</span>
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Inline view of one docker-forensics artifact. JSON inspects are
 * pretty-printed so a `State.Error` / `ExitCode` / port-binding diff
 * lands on its own line; plain-text logs are rendered verbatim. Both
 * variants live in the same `<pre>` so the section reads top-to-bottom
 * like the subprocess log section right below it.
 *
 * Falls back to a one-line "(empty)" stub when the file existed but
 * was zero-length (best-effort write path swallows errors, and
 * `docker logs` on a never-started container returns empty stdout).
 */
function DockerArtifact({ artifact }: { artifact: DockerArtifactFile }) {
  const content = artifact.content;
  if (content.length === 0) {
    return <div className="subprocess-log-empty">(empty)</div>;
  }
  let body = content;
  if (artifact.kind === "json") {
    try {
      const parsed: unknown = JSON.parse(content);
      body = JSON.stringify(parsed, null, 2);
    } catch {
      // Malformed JSON (e.g. truncated `docker inspect` mid-write) —
      // render the raw bytes so the operator can still see what was
      // captured instead of replacing the whole snapshot with an error.
    }
  }
  return <pre className="log docker-artifact-body">{body}</pre>;
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

      <CliCommandSection argv={run.cliArgv} />

      <div className="cards">
        <StatCard label="Score" value={formatAggregateScore(run.scoreTotal)} />
        <StatCard label="Metrics" value={run.metricCount} />
        <StatCard label="Turns" value={run.transcriptTurns} />
        <StatCard label="Cost" value={formatCost(run.totalCostUsd)} />
      </div>

      {(run.status === "abandoned" ||
        run.status === "failed" ||
        run.metadata?.error ||
        run.metadata?.lastHeartbeatAt) && (
        <section className="section debug-section">
          <h2>Debug info</h2>
          {run.metadata?.error && (
            <div className="debug-item bad">
              <strong>Error:</strong>
              <code>{run.metadata.error}</code>
            </div>
          )}
          {run.metadata?.lastHeartbeatAt && (
            <div className="debug-item">
              <strong>Last heartbeat:</strong>
              <span>{run.metadata.lastHeartbeatAt}</span>
            </div>
          )}
          <div className="action-buttons">
            <details className="confirm-action">
              <summary className="bad">Delete run</summary>
              <form
                className="confirm-form"
                method="post"
                action={`/api/runs/${encodeURIComponent(run.runId)}/delete`}
              >
                <input
                  type="hidden"
                  name="backToSession"
                  value={run.sessionId}
                />
                <p className="confirm-prompt">
                  This deletes <code>{run.runId}</code> permanently. It cannot
                  be undone.
                </p>
                <button className="bad" type="submit">
                  Yes, delete this run
                </button>
              </form>
            </details>
          </div>
        </section>
      )}

      {run.dockerArtifacts.length > 0 && (
        <section className="section debug-section">
          <h2>Docker snapshot</h2>
          <p className="section-subtle">
            Container forensics captured at hatch failure, before{" "}
            <code>vellum retire</code> removed the container. Each block is the
            full <code>docker inspect</code> /{" "}
            <code>docker logs --tail 200</code> for a sibling container (
            <code>assistant</code> / <code>gateway</code> /{" "}
            <code>credential-executor</code>), inlined here so port collisions
            and crash exits land in the same scroll as the subprocess logs
            below.
          </p>
          {run.dockerArtifacts.map((artifact) => (
            <div key={artifact.name} className="subprocess-log-block">
              <div className="subprocess-log-head">
                <strong>{artifact.name}</strong>
                <a
                  className="raw-link"
                  href={`/api/runs/${encodeURIComponent(run.runId)}/files/${encodeURIComponent(artifact.name)}`}
                  target="_blank"
                  rel="noopener"
                >
                  raw
                </a>
              </div>
              <DockerArtifact artifact={artifact} />
            </div>
          ))}
        </section>
      )}

      {run.subprocessLogs.length > 0 && (
        <section className="section">
          <h2>Subprocess logs</h2>
          <p className="section-subtle">
            Stdout/stderr from every CLI subprocess the adapter spawned — useful
            when a hatch or setup step failed silently and the error message
            alone doesn't tell you why. Each line is timestamped and tagged in
            the same format as the test runner log so they line up
            column-for-column when read side by side.
          </p>
          {run.subprocessLogs.map((log) => (
            <div key={log.name} className="subprocess-log-block">
              <div className="subprocess-log-head">
                <strong>{log.name}</strong>
                <a
                  className="raw-link"
                  href={`/api/runs/${encodeURIComponent(run.runId)}/files/${encodeURIComponent(log.name)}`}
                  target="_blank"
                  rel="noopener"
                >
                  raw
                </a>
              </div>
              <SubprocessLog log={log} />
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <h2>Metric card</h2>
        <MetricTable metrics={run.metrics} />
      </section>

      <section className="section">
        <h2>Transcript</h2>
        <Transcript turns={run.transcript} />
      </section>

      <section className="section">
        <h2>Memory-formation events</h2>
        <p className="section-subtle">
          V2 only: typed event stream from the agent&apos;s ingest turn —
          consuming the haystack sessions to form memory before the question is
          asked. Empty for V1 runs and for V2 runs whose adapter doesn&apos;t
          expose ingest-side events.
        </p>
        <ContainerLogs
          events={run.ingestAssistantEvents}
          emptyLabel="No memory-formation events recorded."
        />
      </section>

      <section className="section">
        <h2>Container logs</h2>
        <p className="section-subtle">
          Typed event stream emitted by the assistant inside the container
          during the question turn — what the agent said in response to the
          question.
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
        <CostDiagnosticsPanel usage={run.usage} />
      </section>
    </>
  );
}

/**
 * Surface the cost-pricing pipeline's state for a run.
 *
 * Hidden when `costStatus === "ok"` (or when no usage events ran) — a
 * fully priced run shouldn't be cluttered with diagnostic chrome.
 * Otherwise renders a chip (`Partial pricing` / `Cost unavailable`) and a
 * compact per-request breakdown so the reader can see exactly which
 * usage records lacked provider/model/tokens or fell outside the
 * pricing table. Pairs with Vargas's round-3 ask: "costs stuck at 0,
 * add telemetry as to why".
 */
function CostDiagnosticsPanel({ usage }: { usage: UsageSummary }) {
  const chip = costStatusChip(usage.costStatus);
  const diagnostics = usage.costDiagnostics ?? [];
  if (!chip && diagnostics.length === 0) return null;

  return (
    <div className="cost-diag">
      <div className="cost-diag-head">
        <strong>Cost pricing</strong>
        {chip ? <span className={chip.className}>{chip.label}</span> : null}
      </div>
      {diagnostics.length === 0 ? (
        <p className="muted">
          No per-request diagnostics — the gap is at the pipeline level, not on
          individual usage records.
        </p>
      ) : (
        <table className="cost-diag-table">
          <thead>
            <tr>
              <th>Request #</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {diagnostics.map((diag: CostDiagnostic) => (
              <tr key={diag.requestIndex}>
                <td>{diag.requestIndex}</td>
                <td>{diag.provider ?? "—"}</td>
                <td>{diag.model ?? "—"}</td>
                <td>{COST_REASON_LABELS[diag.reason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
