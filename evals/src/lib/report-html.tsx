import { renderToStaticMarkup } from "react-dom/server";

import type { MetricResult } from "./metrics";
import type { ReportRunDetail, ReportRunSummary } from "./report-data";
import type { TranscriptTurn } from "./transcript";

function json(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

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
.shell { max-width: 1440px; margin: 0 auto; padding: 34px; }
.hero { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 24px; }
.eyebrow { color: var(--accent2); text-transform: uppercase; letter-spacing: .16em; font-size: 12px; font-weight: 800; }
h1 { font-size: clamp(34px, 5vw, 64px); line-height: .95; margin: 10px 0; letter-spacing: -0.055em; }
.hero p { color: var(--muted); max-width: 720px; margin: 0; font-size: 16px; }
.pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border); background: rgba(255,255,255,.06); border-radius: 999px; padding: 9px 13px; color: var(--muted); font-size: 13px; }
.grid { display: grid; grid-template-columns: 390px minmax(0, 1fr); gap: 20px; align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 28px; box-shadow: var(--shadow); backdrop-filter: blur(20px); }
.sidebar { padding: 18px; position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow: auto; }
.run-card { display: block; padding: 16px; border: 1px solid transparent; border-radius: 20px; margin-bottom: 10px; background: rgba(255,255,255,.045); transition: .15s ease; }
.run-card:hover, .run-card.active { border-color: rgba(139,92,246,.55); background: rgba(139,92,246,.13); transform: translateY(-1px); }
.run-title { font-weight: 800; margin-bottom: 7px; word-break: break-word; }
.run-meta { display: flex; flex-wrap: wrap; gap: 7px; color: var(--muted); font-size: 12px; }
.content { padding: 24px; }
.empty { padding: 54px; text-align: center; color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.usage-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.stat { padding: 18px; border-radius: 22px; background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.035)); border: 1px solid var(--border); }
.label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; font-weight: 800; }
.value { margin-top: 8px; font-size: 30px; font-weight: 900; letter-spacing: -.04em; }
.section { margin-top: 20px; padding: 20px; border-radius: 24px; background: rgba(0,0,0,.18); border: 1px solid var(--border); }
.section h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: -.03em; }
.run-heading { font-size: 30px; margin: 0 0 18px; letter-spacing: -.04em; }
.run-heading-meta { margin-bottom: 10px; }
table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 16px; }
th, td { padding: 13px 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; }
tr:last-child td { border-bottom: 0; }
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
details pre { max-height: 420px; overflow: auto; padding: 16px; border-radius: 16px; background: rgba(0,0,0,.35); border: 1px solid var(--border); color: #dbeafe; }
@media (max-width: 980px) { .grid { grid-template-columns: 1fr; } .sidebar { position: static; max-height: none; } .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .shell { padding: 18px; } .cards { grid-template-columns: 1fr; } .hero { display: block; } }
`;

function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${statusClass(status)}`}>{status}</span>;
}

function RunCard({ run, active }: { run: ReportRunSummary; active: boolean }) {
  return (
    <a
      className={`run-card ${active ? "active" : ""}`}
      href={`/runs/${encodeURIComponent(run.runId)}`}
    >
      <div className="run-title">{run.runId}</div>
      <div className="run-meta">
        <StatusBadge status={run.status} />
        <span>{run.profileId ?? "unknown profile"}</span>
        <span>{run.testId ?? "unknown test"}</span>
        <span>score {formatNumber(run.scoreTotal)}</span>
      </div>
    </a>
  );
}

function Sidebar({
  runs,
  selectedRunId,
}: {
  runs: ReportRunSummary[];
  selectedRunId?: string;
}) {
  if (runs.length === 0) {
    return (
      <div className="empty">
        No runs yet. Run <code>evals run --profiles p1,p2 --tests t1</code>{" "}
        first.
      </div>
    );
  }

  return (
    <>
      {runs.map((run) => (
        <RunCard
          key={run.runId}
          run={run}
          active={selectedRunId === run.runId}
        />
      ))}
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function scoreClass(score: number): string {
  if (score > 0) return "good";
  if (score < 0) return "bad";
  return "muted";
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

function RunReport({ run }: { run: ReportRunDetail }) {
  return (
    <div>
      <div className="run-meta run-heading-meta">
        <StatusBadge status={run.status} />
        <span>{run.profileId ?? "unknown profile"}</span>
        <span>{run.testId ?? "unknown test"}</span>
      </div>
      <h2 className="run-heading">{run.runId}</h2>

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

      <section className="section">
        <h2>Raw data</h2>
        <details>
          <summary>Open JSON payload</summary>
          <pre>{JSON.stringify(run, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}

function EmptySelection() {
  return (
    <div className="empty">
      <h2>Select a run</h2>
      <p>
        Pick a run on the left to inspect its report card, transcript, usage,
        and raw JSON.
      </p>
    </div>
  );
}

function ReportDocument({
  runs,
  selectedRun,
}: {
  runs: ReportRunSummary[];
  selectedRun?: ReportRunDetail;
}) {
  const selected = selectedRun ?? null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Vellum Evals Report Card</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <div className="shell">
          <header className="hero">
            <div>
              <div className="eyebrow">Personal Intelligence Benchmark</div>
              <h1>Eval report card</h1>
              <p>
                Browse every run in <code>.runs</code>, compare profiles and
                tests, inspect metric reasons, and replay the transcript that
                produced the score.
              </p>
            </div>
            <div className="pill">
              {runs.length} run{runs.length === 1 ? "" : "s"} loaded
            </div>
          </header>
          <main className="grid">
            <aside className="panel sidebar">
              <Sidebar runs={runs} selectedRunId={selected?.runId} />
            </aside>
            <section className="panel content">
              {selected ? <RunReport run={selected} /> : <EmptySelection />}
            </section>
          </main>
        </div>
        <script
          id="runs-data"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: json(runs) }}
        />
        <script
          id="selected-run-data"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: json(selected) }}
        />
      </body>
    </html>
  );
}

export function renderReportPage(input: {
  runs: ReportRunSummary[];
  selectedRun?: ReportRunDetail;
}): string {
  return `<!doctype html>${renderToStaticMarkup(
    <ReportDocument runs={input.runs} selectedRun={input.selectedRun} />,
  )}`;
}
