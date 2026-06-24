import MarkdownIt from "markdown-it";
import katex from "katex";
import katexCssText from "katex/dist/katex.min.css?text";
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
  ReportProfileInSession,
  ReportRunDetail,
  ReportSessionDetail,
  ReportSessionSummary,
  ReportTestInSession,
  SessionProfileAggregate,
  SessionTestEntry,
  SubprocessLogFile,
} from "./report-data";
import type { TranscriptTurn } from "./transcript";
import {
  buildTranscriptView,
  type AssistantBlock,
  type AssistantMessageView,
  type BlockTiming,
} from "./transcript-view";
import type { AgentEvent } from "./adapter";
import { priceUsageRecord } from "./pricing";

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

/** Human-readable byte size, e.g. `812 B`, `14.2 KB`, `3.1 MB`. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Total byte volume of every log stream rendered on the Logs tab: the
 * file-backed subprocess/docker logs plus the serialized container and
 * runner event streams. Surfaced as the Logs pill's headline stat so a
 * reader can gauge how much log there is to read before opening the tab.
 */
function logsSizeBytes(run: ReportRunDetail): number {
  let total = 0;
  for (const log of run.subprocessLogs) total += utf8ByteLength(log.content);
  for (const artifact of run.dockerArtifacts)
    total += utf8ByteLength(artifact.content);
  total += utf8ByteLength(JSON.stringify(run.assistantEvents));
  total += utf8ByteLength(JSON.stringify(run.ingestAssistantEvents));
  total += utf8ByteLength(JSON.stringify(run.progressEvents));
  return total;
}

function readRecordNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readRecordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
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
 * Headline/summary cost, rounded to the nearest cent. Used for the at-a-glance
 * totals (tab pill, run/profile/test list columns, the Cost stat card) where a
 * full six-decimal figure is noise. The per-request breakdown keeps
 * `formatCost`'s full precision so sub-cent per-call costs stay legible.
 */
function formatCostCents(value: number | undefined): string {
  if (value === undefined) return "—";
  return `$${value.toFixed(2)}`;
}

/** Wall-clock duration, e.g. `940ms`, `47s`, `2m 53s`, `1h 04m`. */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Parse an ISO `recorded_at` into epoch milliseconds, or `undefined` when the
 * field is missing or unparseable. Used to order the per-request breakdown by
 * wall-clock time rather than array position.
 */
function recordedAtMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Render an ISO `recorded_at` as a compact `HH:MM:SS` UTC time-of-day. */
function formatRecordedAt(value: string | undefined): string {
  const ms = recordedAtMs(value);
  if (ms === undefined) return "—";
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

/**
 * Render a single request's round-trip latency compactly: `840ms` under a
 * second, one-decimal seconds (`2.3s`) above it. Distinct from
 * `formatDuration` (whole-second run wall-clock) because a per-request figure
 * is small enough that the sub-second tenths carry signal.
 */
function formatRequestDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Whole-millisecond span between two ISO stamps, or `undefined` when either is
 * missing or the pair is non-monotonic. Used to label how long a transcript
 * chunk (a streamed text/thinking run, or a tool call) occupied the stream.
 */
function spanMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
): number | undefined {
  const start = recordedAtMs(startedAt);
  const end = recordedAtMs(endedAt);
  if (start === undefined || end === undefined || end < start) {
    return undefined;
  }
  return end - start;
}

/**
 * Markdown renderer for assistant message text. `html: false` escapes any raw
 * HTML in the model's output, so an answer containing `<script>` or inline
 * event handlers can't inject live markup into the report — only Markdown
 * constructs (headings, lists, code, tables, emphasis) become elements.
 * `linkify` turns bare URLs into links and `breaks` keeps single newlines as
 * line breaks so chat-style answers render the way they were written.
 */
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

/**
 * Render Markdown images as inert links rather than `<img>` elements. The
 * report is an offline artifact that renders untrusted assistant output and may
 * be opened or shared outside the eval egress jail, so an auto-loaded
 * `<img src="https://…">` would make merely opening it fetch a model-supplied
 * URL — leaking the viewer's IP/metadata. A link carries the same information
 * (alt text + destination) without any automatic network request, and runs
 * through the renderer's own `validateLink` so unsafe schemes degrade to plain
 * text.
 */
markdown.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet("src") ?? "";
  const alt = token.content.length > 0 ? token.content : src;
  const label = markdown.utils.escapeHtml(alt);
  if (!markdown.validateLink(src)) {
    return label;
  }
  const href = markdown.utils.escapeHtml(src);
  return `<a class="md-image-link" href="${href}" rel="noopener noreferrer nofollow">${label}</a>`;
};

/**
 * Render Markdown with inline LaTeX support. Extracts `$$...$$` (display)
 * and `$...$` (inline) math blocks before markdown processing, renders them
 * with KaTeX, then reinserts the rendered HTML so the markdown parser doesn't
 * mangle the math syntax. Placeholder tokens survive markdown untouched
 * because they contain no special characters.
 */
function renderMarkdownWithMath(text: string): string {
  const mathBlocks: string[] = [];
  const PLACEHOLDER = (i: number) => `MATHBLOCK${i}ENDMATHBLOCK`;

  // Extract $$...$$ (display math) first — greedy across newlines.
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr: string) => {
    const i = mathBlocks.length;
    try {
      mathBlocks.push(
        katex.renderToString(expr.trim(), {
          displayMode: true,
          throwOnError: false,
        }),
      );
    } catch {
      mathBlocks.push(`<code>$$${expr}$$</code>`);
    }
    return PLACEHOLDER(i);
  });

  // Extract $...$ (inline math) — but not inside code spans or after $.
  processed = processed.replace(
    /(^|[^$])\$(?!\s)([^\n$]+?)(?!\s)\$(?!\d)/g,
    (_, pre: string, expr: string) => {
      const i = mathBlocks.length;
      try {
        mathBlocks.push(
          katex.renderToString(expr.trim(), {
            displayMode: false,
            throwOnError: false,
          }),
        );
      } catch {
        mathBlocks.push(`<code>$${expr}$</code>`);
      }
      return `${pre}${PLACEHOLDER(i)}`;
    },
  );

  // Render markdown, then reinsert math blocks.
  const html = markdown.render(processed);
  return html.replace(
    /MATHBLOCK(\d+)ENDMATHBLOCK/g,
    (_, i: string) => mathBlocks[Number(i)] ?? "",
  );
}

/**
 * A chunk's run time, shown only on hover of its chunk (CSS reveal) so the
 * transcript stays uncluttered. The badge's own `title` surfaces the chunk's
 * start time on hover, so the two timestamps are one interaction apart without
 * needing client-side script. Renders nothing when the span isn't measurable.
 */
function ChunkDuration({ startedAt, endedAt }: BlockTiming) {
  const ms = spanMs(startedAt, endedAt);
  if (ms === undefined) {
    return null;
  }
  return (
    <span
      className="chunk-duration"
      title={`started ${formatRecordedAt(startedAt)}`}
    >
      {formatRequestDuration(ms)}
    </span>
  );
}

/**
 * Render a metric `score` using its declared unit.
 *
 * `MetricResult.unit` defaults to `"fraction"` — the score is a 0-1
 * quality fraction, displayed as `XX.XX%`.
 *
 * `"raw"` opts out — for a score that carries units with no meaning as a
 * percent (e.g. a latency in milliseconds). Those fall back to plain
 * number formatting.
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
.profile-info { margin: 0; display: grid; gap: 14px; padding: 18px 20px; border: 1px solid var(--border); border-radius: 18px; background: rgba(255,255,255,.04); }
.profile-info > div { display: grid; grid-template-columns: 120px 1fr; gap: 16px; align-items: start; }
.profile-info dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0; }
.profile-info dd { margin: 0; }
.profile-setup { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.profile-setup code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
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
.transcript-wrap { display: flex; flex-direction: column; gap: 12px; }
.transcript-header { display: flex; align-items: center; justify-content: center; gap: 12px; }
.transcript-header h2 { margin: 0; }
.conversation-switcher { display: flex; flex-direction: column; gap: 12px; }
.conv-tab-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.conversation-tablist { display: inline-flex; gap: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: rgba(0,0,0,.18); }
.conv-tab-label { padding: 6px 18px; font-size: 13px; font-weight: 700; color: var(--muted); cursor: pointer; transition: .15s ease; user-select: none; border-right: 1px solid var(--border); }
.conv-tab-label:last-child { border-right: 0; }
.conv-tab-label:hover { color: var(--text); background: rgba(139,92,246,.1); }
.conversation-panel { display: none; }
.turn { padding: 14px 16px; border-radius: 18px; border: 1px solid var(--border); background: rgba(255,255,255,.045); }
.turn.assistant { border-color: rgba(34,211,238,.22); }
.turn.simulator { border-color: rgba(139,92,246,.24); }
.turn-head { display: flex; justify-content: space-between; gap: 14px; color: var(--muted); font-size: 12px; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .1em; font-weight: 800; }
.turn-time { margin-top: 8px; text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.turn-body { white-space: pre-wrap; line-height: 1.5; }
.turn-body + .turn-body, .turn .block-thinking + .turn-body, .turn .block-tool + .turn-body { margin-top: 10px; }
.chunk { position: relative; }
.chunk-duration { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .12s ease; cursor: help; }
.chunk:hover .chunk-duration, details[open].chunk > summary .chunk-duration { opacity: 1; }
.turn-body.chunk > .chunk-duration { position: absolute; top: 4px; right: 6px; }
.block-thinking > summary .chunk-duration, .block-tool > summary .chunk-duration { margin-left: auto; }
.md { white-space: normal; line-height: 1.6; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 10px; }
.md h1, .md h2, .md h3, .md h4 { margin: 16px 0 8px; line-height: 1.3; font-weight: 800; }
.md h1 { font-size: 20px; } .md h2 { font-size: 17px; } .md h3 { font-size: 15px; } .md h4 { font-size: 13px; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
.md li { margin: 2px 0; }
.md a { color: var(--accent2); }
.md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: rgba(0,0,0,.4); border: 1px solid var(--border); border-radius: 6px; padding: 1px 5px; }
.md pre { margin: 0 0 10px; padding: 12px 14px; border-radius: 10px; background: rgba(0,0,0,.45); border: 1px solid var(--border); overflow: auto; }
.md pre code { background: none; border: 0; padding: 0; font-size: 12.5px; line-height: 1.5; }
.md blockquote { margin: 0 0 10px; padding: 2px 14px; border-left: 3px solid var(--border); color: var(--muted); }
.md table { border-collapse: collapse; margin: 0 0 10px; font-size: 13px; }
.md th, .md td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
.md th { background: rgba(255,255,255,.04); font-weight: 800; }
.md hr { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
.block-thinking { margin: 8px 0; border: 1px dashed rgba(180,190,255,.24); border-radius: 12px; background: rgba(255,255,255,.025); }
.block-thinking > summary { cursor: pointer; padding: 8px 12px; display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .1em; font-weight: 800; user-select: none; }
.block-thinking > summary::-webkit-details-marker { display: none; }
.block-thinking-body { padding: 0 12px 10px; color: var(--muted); font-size: 13px; line-height: 1.5; white-space: pre-wrap; font-style: italic; }
.block-tool { margin: 8px 0; border: 1px solid rgba(34,211,238,.2); border-radius: 12px; background: rgba(34,211,238,.04); }
.block-tool > summary { cursor: pointer; padding: 8px 12px; display: flex; align-items: center; gap: 10px; user-select: none; }
.block-tool > summary::-webkit-details-marker { display: none; }
.block-tool-glyph { color: var(--accent2); font-size: 13px; }
.block-tool-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 700; }
.block-tool-io { padding: 0 12px 10px; }
.block-tool-io-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .14em; font-weight: 800; margin-bottom: 4px; }
.block-tool-io pre { margin: 0; max-height: 280px; overflow: auto; padding: 10px 12px; border-radius: 10px; background: rgba(0,0,0,.4); border: 1px solid var(--border); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.block-surface { border-color: rgba(139,92,246,.28); background: rgba(139,92,246,.06); }
.block-page { padding: 8px; }
.block-page-head { display: flex; align-items: center; gap: 10px; padding: 4px 6px 8px; }
.block-page-frame { display: block; width: 100%; height: 480px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
.block-page-source { margin-top: 8px; }
.block-page-source > summary { cursor: pointer; padding: 4px 6px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; font-weight: 800; user-select: none; }
.block-page-source > summary::-webkit-details-marker { display: none; }
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
.cost-requests { margin-top: 16px; }
.cost-requests h3 { font-size: 16px; margin: 0 0 10px; letter-spacing: -.02em; }
.cost-req-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cost-req-table th, .cost-req-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.cost-req-table th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; font-weight: 800; }
.cost-req-table tbody:hover { background: rgba(255,255,255,.02); }
.req-duration { color: var(--muted); font-size: 12px; }
.cost-req-table .payload-row td { padding: 0 10px 8px; border-bottom: 1px solid var(--border); }
.payload-details > summary { cursor: pointer; color: var(--muted); font-size: 12px; list-style: none; padding: 4px 0; }
.payload-details > summary::-webkit-details-marker { display: none; }
.payload-details > summary::before { content: "▸ "; }
.payload-details[open] > summary::before { content: "▾ "; }
.payload-details[open] > summary:hover, .payload-details > summary:hover { color: var(--accent2); }
.payload-body h4 { margin: 10px 0 4px; font-size: 12px; color: var(--muted); font-weight: 800; }
.payload-pre { max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.tabs { margin-top: 4px; }
.tab-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.tablist { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.tab-pill { display: flex; flex-direction: column; gap: 8px; padding: 18px; border-radius: 22px; background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.035)); border: 1px solid var(--border); cursor: pointer; transition: .15s ease; }
.tab-pill:hover { border-color: rgba(139,92,246,.45); transform: translateY(-1px); }
.tab-pill-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .12em; font-weight: 800; }
.tab-pill-value { font-size: 30px; font-weight: 900; letter-spacing: -.04em; }
.tabpanel { display: none; padding: 24px; border-radius: 24px; background: rgba(0,0,0,.18); border: 1px solid var(--border); }
.tabpanel h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: -.03em; }
#exec-tab-score:checked ~ .tabpanels .panel-score,
#exec-tab-responses:checked ~ .tabpanels .panel-responses,
#exec-tab-cost:checked ~ .tabpanels .panel-cost,
#exec-tab-logs:checked ~ .tabpanels .panel-logs { display: block; }
#exec-tab-score:checked ~ .tablist label[for="exec-tab-score"],
#exec-tab-responses:checked ~ .tablist label[for="exec-tab-responses"],
#exec-tab-cost:checked ~ .tablist label[for="exec-tab-cost"],
#exec-tab-logs:checked ~ .tablist label[for="exec-tab-logs"] { border-color: rgba(139,92,246,.7); background: linear-gradient(180deg, rgba(139,92,246,.22), rgba(34,211,238,.08)); }
#exec-tab-score:focus-visible ~ .tablist label[for="exec-tab-score"],
#exec-tab-responses:focus-visible ~ .tablist label[for="exec-tab-responses"],
#exec-tab-cost:focus-visible ~ .tablist label[for="exec-tab-cost"],
#exec-tab-logs:focus-visible ~ .tablist label[for="exec-tab-logs"] { outline: 2px solid var(--accent2); outline-offset: 2px; }
.log-group { margin-top: 24px; }
.log-group:first-child { margin-top: 0; }
.log-group h3 { font-size: 16px; margin: 0 0 8px; letter-spacing: -.02em; }
.metric-card-list { display: flex; flex-direction: column; gap: 10px; }
.metric-card { border: 1px solid var(--border); border-radius: 16px; background: rgba(255,255,255,.04); overflow: hidden; }
.metric-card > summary { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 14px 16px; cursor: pointer; list-style: none; }
.metric-card > summary::-webkit-details-marker { display: none; }
.metric-card > summary::after { content: "▸"; color: var(--muted); transition: transform .15s ease; }
.metric-card[open] > summary::after { transform: rotate(90deg); }
.metric-card-name { font-weight: 800; }
.metric-card-detail { padding: 0 16px 16px; border-top: 1px solid var(--border); }
.metric-card-reason { white-space: pre-wrap; line-height: 1.5; margin: 12px 0 0; }
.metric-card-meta { display: grid; gap: 8px; margin: 14px 0 0; }
.metric-card-meta > div { display: grid; grid-template-columns: 160px 1fr; gap: 12px; align-items: start; }
.metric-card-meta dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin: 0; }
.metric-card-meta dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-word; }
.debug-section { border: 1px solid rgba(251, 113, 133, .24); background: rgba(251, 113, 133, .06); }
.phase-timing { margin-bottom: 22px; }
.phase-timing-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--border); margin-bottom: 10px; }
.phase-bar-segment { height: 100%; transition: width .2s ease; }
.phase-setup { background: #6366f1; }
.phase-ingest { background: #22d3ee; }
.phase-question { background: #a78bfa; }
.phase-grading { background: #34d399; }
.phase-other { background: #64748b; }
.phase-timing-labels { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
.phase-timing-item { display: inline-flex; align-items: center; gap: 6px; }
.phase-timing-item strong { color: var(--text); font-variant-numeric: tabular-nums; }
.phase-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.phase-timing-total { margin-left: auto; }
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

function IndexPage({
  sessions,
  readOnly,
}: {
  sessions: ReportSessionSummary[];
  readOnly: boolean;
}) {
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
            {!readOnly && (
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
            )}
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
  if (aggregate.totalRuntimeMs !== undefined) {
    parts.push(formatDuration(aggregate.totalRuntimeMs));
  }
  if (aggregate.totalCostUsd !== undefined) {
    parts.push(formatCostCents(aggregate.totalCostUsd));
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
              href={`/sessions/${encodeURIComponent(session.sessionId)}/profiles/${encodeURIComponent(aggregate.profileId)}`}
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
          {profile.assistantResponses}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {formatDuration(profile.runtimeMs)}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {formatCostCents(profile.totalCostUsd)}
        </a>
      </td>
    </tr>
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
              <th>Responses</th>
              <th>Runtime</th>
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
    </>
  );
}

function setupCommands(
  setup: NonNullable<ReportProfileInSession["info"]>["setup"],
): string[] {
  if (setup === undefined) return [];
  return Array.isArray(setup) ? setup : [setup];
}

function ProfileInfoPanel({
  profileId,
  info,
}: {
  profileId: string;
  info?: ReportProfileInSession["info"];
}) {
  const commands = setupCommands(info?.setup);
  return (
    <dl className="profile-info">
      <div>
        <dt>Profile</dt>
        <dd>{profileId}</dd>
      </div>
      <div>
        <dt>Species</dt>
        <dd>{info?.species ?? "—"}</dd>
      </div>
      {info?.version ? (
        <div>
          <dt>Version</dt>
          <dd>{info.version}</dd>
        </div>
      ) : null}
      <div>
        <dt>Description</dt>
        <dd>
          {info?.description ?? "No description in this profile's manifest."}
        </dd>
      </div>
      <div>
        <dt>Setup</dt>
        <dd>
          {commands.length === 0 ? (
            "None — bare profile."
          ) : (
            <ul className="profile-setup">
              {commands.map((command, index) => (
                <li key={index}>
                  <code>{command}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

function ProfileTestRow({
  sessionId,
  profileId,
  entry,
}: {
  sessionId: string;
  profileId: string;
  entry: ReportProfileInSession["tests"][number];
}) {
  const url = `/sessions/${encodeURIComponent(sessionId)}/tests/${encodeURIComponent(entry.testId)}/profiles/${encodeURIComponent(profileId)}`;
  return (
    <tr className="linked">
      <td>
        <a href={url} className="row-link">
          <strong>{entry.testId}</strong>
        </a>
      </td>
      <td>
        <a href={url} className="row-link">
          <StatusBadge status={entry.status} />
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
      <td>
        <a href={url} className="row-link muted">
          {entry.metricCount}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {entry.assistantResponses}
        </a>
      </td>
      <td>
        <a href={url} className="row-link muted">
          {formatCostCents(entry.totalCostUsd)}
        </a>
      </td>
    </tr>
  );
}

function ProfileInSessionPage({
  profile,
}: {
  profile: ReportProfileInSession;
}) {
  const sessionUrl = `/sessions/${encodeURIComponent(profile.sessionId)}`;
  return (
    <>
      <Crumbs
        trail={[
          { href: "/", label: "All runs" },
          {
            href: sessionUrl,
            label: profile.sessionLabel ?? profile.sessionId,
          },
          { label: profile.profileId },
        ]}
      />
      <h1 className="run-heading">{profile.profileId}</h1>
      <div className="run-heading-meta">
        <span className={`score ${scoreClass(profile.scoreTotal)}`}>
          {formatAggregateScore(profile.scoreTotal)} overall
        </span>
        <span>
          {profile.tests.length} test{profile.tests.length === 1 ? "" : "s"}
        </span>
      </div>

      <section className="section">
        <h2>Profile</h2>
        <ProfileInfoPanel profileId={profile.profileId} info={profile.info} />
      </section>

      <section className="section">
        <h2>Test scores</h2>
        <p className="section-subtle">
          How this profile scored on every test in the run. Click a test to open
          its transcript and logs.
        </p>
        <table>
          <thead>
            <tr>
              <th>Test</th>
              <th>Status</th>
              <th>Score</th>
              <th>Metrics</th>
              <th>Responses</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {profile.tests.map((entry) => (
              <ProfileTestRow
                key={entry.testId}
                sessionId={profile.sessionId}
                profileId={profile.profileId}
                entry={entry}
              />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/**
 * The Score tab's report card: one expandable row per metric. The summary
 * always shows the metric name + its scored value; expanding reveals the
 * scorer's `reason` and any structured `metadata` it attached. Rendered with
 * native `<details>` so it stays interactive in the fully static,
 * no-JS report bundle.
 */
function MetricReportCard({ metrics }: { metrics: MetricResult[] }) {
  if (metrics.length === 0) {
    return <p className="muted">No metrics recorded for this run yet.</p>;
  }

  return (
    <div className="metric-card-list">
      {metrics.map((metric) => {
        const meta = metric.metadata ? Object.entries(metric.metadata) : [];
        return (
          <details key={metric.name} className="metric-card">
            <summary className="metric-card-summary">
              <span className="metric-card-name">{metric.name}</span>
              <span className={`score ${scoreClass(metric.score)}`}>
                {formatScore(metric.score, metric.unit, 2)}
              </span>
            </summary>
            <div className="metric-card-detail">
              {metric.reason ? (
                <p className="metric-card-reason">{metric.reason}</p>
              ) : (
                <p className="muted">No reason recorded for this metric.</p>
              )}
              {meta.length > 0 && (
                <dl className="metric-card-meta">
                  {meta.map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>
                        {typeof value === "string"
                          ? value
                          : JSON.stringify(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function formatBlockJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Narrow a `dynamic_page` surface payload to its renderable HTML plus an
 * optional pixel-height hint. Returns undefined when the payload carries no
 * usable html string, so the caller falls back to the JSON view.
 */
function dynamicPageHtml(
  data: unknown,
): { html: string; height?: number } | undefined {
  if (typeof data !== "object" || data === null || !("html" in data)) {
    return undefined;
  }
  const { html } = data;
  if (typeof html !== "string" || html.length === 0) {
    return undefined;
  }
  let height: number | undefined;
  if ("height" in data) {
    const raw = data.height;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      height = Math.min(Math.max(Math.round(raw), 200), 1200);
    }
  }
  return { html, height };
}

/**
 * In-memory `localStorage` / `sessionStorage` shim prepended into the
 * sandboxed surface iframe. Without `allow-same-origin` those globals throw a
 * `SecurityError`, breaking any page that touches them during init. Mirrors
 * the canonical bridge in clients/web/src/utils/sandbox-bridge.ts (the web chat
 * renders the same surfaces); kept inline because evals is a separate build
 * unit that can't import the web app.
 */
const SURFACE_STORAGE_POLYFILL = `<script>
(function(){
  var store={};
  var shim={
    getItem:function(k){return Object.prototype.hasOwnProperty.call(store,k)?store[k]:null;},
    setItem:function(k,v){store[k]=String(v);},
    removeItem:function(k){delete store[k];},
    clear:function(){store={};},
    get length(){return Object.keys(store).length;},
    key:function(i){return Object.keys(store)[i]||null;}
  };
  try{Object.defineProperty(window,'localStorage',{value:shim,writable:true,configurable:true});}catch(e){window.localStorage=shim;}
  try{Object.defineProperty(window,'sessionStorage',{value:shim,writable:true,configurable:true});}catch(e){window.sessionStorage=shim;}
})();
</script>`;

/**
 * No-op `window.vellum` bridge prepended into the sandboxed surface iframe.
 * App-backed pages expect the host APIs that clients/web/src/utils/sandbox-bridge.ts
 * injects (`window.vellum.sendAction` / `window.vellum.fetch`) and call them
 * during init; a static report has no daemon to forward to, so this stub keeps
 * those pages from throwing on startup — actions are dropped and fetches reject.
 */
const SURFACE_VELLUM_BRIDGE = `<script>
(function(){
  window.vellum={
    route:null,
    sendAction:function(){},
    fetch:function(){return Promise.reject(new Error("vellum bridge unavailable in offline report"));}
  };
})();
</script>`;

/**
 * Prepend the storage polyfill and the no-op vellum bridge so both run before
 * any inline page script. Insertion priority matches the web app's bridge:
 * right after `<head>`, else prepended to the raw markup.
 */
function prepareSurfaceHtml(html: string): string {
  const prelude = SURFACE_STORAGE_POLYFILL + SURFACE_VELLUM_BRIDGE;
  const headMatch = /<head(\s[^>]*)?>/i.exec(html);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return html.slice(0, at) + prelude + html.slice(at);
  }
  return prelude + html;
}

function ToolCallBlock({
  block,
}: {
  block: Extract<AssistantBlock, { kind: "tool_call" }>;
}) {
  const statusLabel =
    block.status === "running" ? "running" : block.isError ? "error" : "done";
  const statusClassName =
    block.status === "running" ? "warn" : block.isError ? "bad" : "good";
  return (
    <details className="block-tool chunk">
      <summary>
        <span className="block-tool-glyph">⚙</span>
        <span className="block-tool-name">{block.toolName || "tool"}</span>
        <span className={`chip ${statusClassName}`}>{statusLabel}</span>
        <ChunkDuration startedAt={block.startedAt} endedAt={block.endedAt} />
      </summary>
      {block.input !== undefined && (
        <div className="block-tool-io">
          <div className="block-tool-io-label">input</div>
          <pre>{formatBlockJson(block.input)}</pre>
        </div>
      )}
      {block.result !== undefined && (
        <div className="block-tool-io">
          <div className="block-tool-io-label">result</div>
          <pre>{block.result}</pre>
        </div>
      )}
    </details>
  );
}

function AssistantMessage({ message }: { message: AssistantMessageView }) {
  return (
    <>
      {message.blocks.map((block, index) => {
        if (block.kind === "text") {
          return (
            <div key={index} className="turn-body chunk">
              <div
                className="md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdownWithMath(block.text),
                }}
              />
              <ChunkDuration
                startedAt={block.startedAt}
                endedAt={block.endedAt}
              />
            </div>
          );
        }
        if (block.kind === "thinking") {
          return (
            <details key={index} className="block-thinking chunk">
              <summary>
                <span>Thinking</span>
                <ChunkDuration
                  startedAt={block.startedAt}
                  endedAt={block.endedAt}
                />
              </summary>
              <div className="block-thinking-body">{block.thinking}</div>
            </details>
          );
        }
        if (block.kind === "tool_call") {
          return <ToolCallBlock key={index} block={block} />;
        }
        const label = `${block.surfaceType}${block.title ? ` — ${block.title}` : ""}`;
        const page =
          block.surfaceType === "dynamic_page"
            ? dynamicPageHtml(block.data)
            : undefined;
        if (page) {
          return (
            <div key={index} className="block-tool block-surface block-page">
              <div className="block-page-head">
                <span className="block-tool-glyph">▢</span>
                <span className="block-tool-name">{label}</span>
              </div>
              {/* Untrusted assistant-generated HTML: sandbox without
                  allow-same-origin so scripts run but can't reach the report
                  origin, cookies, or storage. */}
              <iframe
                className="block-page-frame"
                title={label}
                sandbox="allow-scripts"
                srcDoc={prepareSurfaceHtml(page.html)}
                style={page.height ? { height: `${page.height}px` } : undefined}
              />
              <details className="block-page-source">
                <summary>Surface data</summary>
                <div className="block-tool-io">
                  <pre>{formatBlockJson(block.data)}</pre>
                </div>
              </details>
            </div>
          );
        }
        return (
          <details key={index} className="block-tool block-surface">
            <summary>
              <span className="block-tool-glyph">▢</span>
              <span className="block-tool-name">{label}</span>
            </summary>
            {block.data !== undefined && (
              <div className="block-tool-io">
                <pre>{formatBlockJson(block.data)}</pre>
              </div>
            )}
          </details>
        );
      })}
    </>
  );
}

function Transcript({
  turns,
  assistantEvents,
  ingestAssistantEvents = [],
}: {
  turns: TranscriptTurn[];
  assistantEvents: AgentEvent[];
  ingestAssistantEvents?: AgentEvent[];
}) {
  const items = buildTranscriptView(turns, [
    ...ingestAssistantEvents,
    ...assistantEvents,
  ]);

  const headerText = "Transcript";
  const subText =
    "Simulator turns interleaved with the assistant's reply — text, thinking, tool calls, and surfaces grouped per assistant message, folded from the container event stream.";

  if (items.length === 0) {
    return (
      <>
        <h2>{headerText}</h2>
        <p className="section-subtle">{subText}</p>
        <p className="muted">No transcript turns recorded.</p>
      </>
    );
  }

  // Group items by conversationKey. Turns without a key (legacy runs or
  // single-conversation benchmarks) go into a single default group so the
  // dropdown only appears when there are genuinely multiple conversations.
  const groups: { key: string; label: string; items: typeof items }[] = [];
  const DEFAULT_KEY = "__default__";
  for (const item of items) {
    const key = item.conversationKey ?? DEFAULT_KEY;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = {
        key,
        label: conversationLabel(key, turns),
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }

  // Single conversation (or legacy with no keys) — render flat, no dropdown.
  if (groups.length <= 1) {
    return (
      <>
        <h2>{headerText}</h2>
        <p className="section-subtle">{subText}</p>
        <div className="transcript">
          {(groups[0]?.items ?? items).map((item, index) => (
            <TranscriptItem
              key={`${item.emittedAt ?? ""}-${index}`}
              item={item}
            />
          ))}
        </div>
      </>
    );
  }

  // Multiple conversations — a segmented control inline with the header
  // toggles which panel is visible. Built with hidden radio inputs +
  // `:checked` sibling selectors, exactly like the run's main tabs, so it
  // stays fully interactive in the static, no-JS report bundle (and under
  // a CSP that blocks inline scripts). The earlier <select> + inline
  // <script> version silently no-op'd in those contexts — the script
  // never ran, so switching Ingest → Question left the first conversation
  // visible.
  //
  // All radios must be siblings of the panels (inside one wrapper) for the
  // `~` selector to reach them; the header + tablist sit between, also as
  // siblings, so the active-label highlight rules can target them too.
  return (
    <>
      <div className="conversation-switcher">
        {groups.map((group, index) => (
          <input
            key={`input-${group.key}`}
            className="conv-tab-input"
            type="radio"
            name="conversation-tab"
            id={`conversation-tab-${index}`}
            defaultChecked={index === 0}
          />
        ))}
        <div className="transcript-header">
          <h2>{headerText}</h2>
          <div className="conversation-tablist" role="tablist">
            {groups.map((group, index) => (
              <label
                key={`label-${group.key}`}
                className="conv-tab-label"
                htmlFor={`conversation-tab-${index}`}
              >
                {group.label}
              </label>
            ))}
          </div>
        </div>
        <p className="section-subtle">{subText}</p>
        <div className="transcript-wrap">
          {groups.map((group, index) => (
            <div
              key={group.key}
              className="transcript conversation-panel"
              data-conv-index={index}
            >
              {group.items.map((item, i) => (
                <TranscriptItem
                  key={`${item.emittedAt ?? ""}-${i}`}
                  item={item}
                />
              ))}
            </div>
          ))}
        </div>
        {/* CSS rules generated per-render so the :checked selectors match
            the exact number of conversations (the report is static HTML,
            so a fixed rule count would cap the supported group count). */}
        <style
          dangerouslySetInnerHTML={{
            __html: groups
              .map(
                (_g, i) =>
                  `#conversation-tab-${i}:checked ~ .transcript-wrap .conversation-panel[data-conv-index="${i}"]{display:flex;}` +
                  `#conversation-tab-${i}:checked ~ .transcript-header .conversation-tablist label[for="conversation-tab-${i}"]{border-color:rgba(139,92,246,.7);background:linear-gradient(180deg,rgba(139,92,246,.22),rgba(34,211,238,.08));color:var(--text);}`,
              )
              .join(""),
          }}
        />
      </div>
    </>
  );
}

/** Human-readable label for a conversation key, derived from the turns. */
function conversationLabel(key: string, turns: TranscriptTurn[]): string {
  if (key === "__default__") return "Conversation";
  // The first simulator turn with this conversationKey tells us which
  // phase it is — ingest prompts mention "staged" / "trajectory" /
  // "memory", question prompts are the actual test question.
  const firstSim = turns.find(
    (t) => t.role === "simulator" && t.conversationKey === key,
  );
  if (!firstSim) return key.length > 12 ? `${key.slice(0, 12)}…` : key;
  const content = firstSim.content.toLowerCase();
  if (
    content.includes("staged") ||
    content.includes("trajectory") ||
    content.includes("memory")
  ) {
    return "Ingest";
  }
  return "Question";
}

function TranscriptItem({
  item,
}: {
  item: ReturnType<typeof buildTranscriptView>[number];
}) {
  const stamp = item.role === "simulator" ? item.emittedAt : item.endedAt;
  return (
    <article key={`${item.emittedAt ?? ""}`} className={`turn ${item.role}`}>
      <div className="turn-head">
        <span>{item.role}</span>
      </div>
      {item.role === "simulator" ? (
        <div
          className="turn-body md"
          dangerouslySetInnerHTML={{
            __html: renderMarkdownWithMath(item.content),
          }}
        />
      ) : (
        <AssistantMessage message={item} />
      )}
      {stamp ? (
        <div className="turn-time">{formatRecordedAt(stamp)}</div>
      ) : null}
    </article>
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

/**
 * The Logs tab: every process-log stream for a run, stacked. Groups the
 * container/forensic snapshots and the structured event/runner logs that
 * used to be separate top-level sections so they all live behind one tab.
 */
function LogsPanel({ run }: { run: ReportRunDetail }) {
  return (
    <>
      {run.dockerArtifacts.length > 0 && (
        <div className="log-group">
          <h3>Docker snapshot</h3>
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
        </div>
      )}

      {run.subprocessLogs.length > 0 && (
        <div className="log-group">
          <h3>Subprocess logs</h3>
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
        </div>
      )}

      <div className="log-group">
        <h3>Memory-formation events</h3>
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
      </div>

      <div className="log-group">
        <h3>Container logs</h3>
        <p className="section-subtle">
          Typed event stream emitted by the assistant inside the container
          during the question turn — what the agent said in response to the
          question.
        </p>
        <ContainerLogs events={run.assistantEvents} />
      </div>

      <div className="log-group">
        <h3>Test runner logs</h3>
        <p className="section-subtle">
          Step-by-step trace from the eval runner: hatching, setup, simulator
          turns, metric scoring, shutdown.
        </p>
        <RunnerLogs events={run.progressEvents} />
      </div>
    </>
  );
}

/**
 * Tabbed body of the per-execution page. The four pills double as both the
 * run's headline stats (score / turn count / cost / log count) and the tab
 * controls — clicking one swaps the panel below. Implemented with hidden
 * radio inputs + `:checked` sibling selectors so it stays fully interactive
 * in the static, no-JS report bundle. Score is selected by default.
 */
function ExecutionTabs({ run }: { run: ReportRunDetail }) {
  const logsSize = logsSizeBytes(run);
  return (
    <div className="tabs">
      <input
        className="tab-input"
        type="radio"
        name="exec-tab"
        id="exec-tab-score"
        defaultChecked
      />
      <input
        className="tab-input"
        type="radio"
        name="exec-tab"
        id="exec-tab-responses"
      />
      <input
        className="tab-input"
        type="radio"
        name="exec-tab"
        id="exec-tab-cost"
      />
      <input
        className="tab-input"
        type="radio"
        name="exec-tab"
        id="exec-tab-logs"
      />
      <div className="tablist" role="tablist">
        <label className="tab-pill" htmlFor="exec-tab-score">
          <span className="tab-pill-label">Score</span>
          <span className="tab-pill-value">
            {formatAggregateScore(run.scoreTotal)}
          </span>
        </label>
        <label className="tab-pill" htmlFor="exec-tab-responses">
          <span className="tab-pill-label">Responses</span>
          <span className="tab-pill-value">{run.assistantResponses}</span>
        </label>
        <label className="tab-pill" htmlFor="exec-tab-cost">
          <span className="tab-pill-label">Cost</span>
          <span className="tab-pill-value">
            {formatCostCents(run.totalCostUsd)}
          </span>
        </label>
        <label className="tab-pill" htmlFor="exec-tab-logs">
          <span className="tab-pill-label">Logs</span>
          <span className="tab-pill-value">{formatBytes(logsSize)}</span>
        </label>
      </div>
      <div className="tabpanels">
        <section className="tabpanel panel-score">
          <h2>Metric report card</h2>
          <p className="section-subtle">
            Every metric scored for this run. Expand a metric for its scoring
            reason and any structured metadata.
          </p>
          <MetricReportCard metrics={run.metrics} />
        </section>

        <section className="tabpanel panel-responses">
          <Transcript
            turns={run.transcript}
            assistantEvents={run.assistantEvents}
            ingestAssistantEvents={run.ingestAssistantEvents}
          />
        </section>

        <section className="tabpanel panel-cost">
          <h2>Cost breakdown</h2>
          <p className="section-subtle">
            Token usage and dollar cost for this run, metered from the egress
            jail&apos;s observed model traffic.
          </p>
          <CostRequestsTable usage={run.usage} />
          <CostDiagnosticsPanel usage={run.usage} />
        </section>

        <section className="tabpanel panel-logs">
          <h2>Process logs</h2>
          <p className="section-subtle">
            Every log stream captured for this run — container forensics,
            subprocess stdout/stderr, agent event streams, and the test-runner
            trace.
          </p>
          <LogsPanel run={run} />
        </section>
      </div>
    </div>
  );
}

/**
 * Per-phase wall-clock timing breakdown. Computes durations from the progress
 * events (setup/send/metrics) and the ingest + question event streams, so the
 * user can see where time was spent — especially when a run takes 5+ minutes
 * and it's not clear whether the ingest or the question turn dominated.
 */
function PhaseTiming({ run }: { run: ReportRunDetail }) {
  // Derive phase spans from progress events.
  const setupStart = run.progressEvents.find(
    (e) => e.step === "setup" && e.status === "start",
  )?.emittedAt;
  const setupEnd = run.progressEvents.find(
    (e) => e.step === "setup" && e.status === "done",
  )?.emittedAt;
  const sendStart = run.progressEvents.find(
    (e) => e.step === "send" && e.status === "start",
  )?.emittedAt;
  const sendEnd = run.progressEvents.find(
    (e) => e.step === "send" && e.status === "done",
  )?.emittedAt;
  const metricsStart = run.progressEvents.find(
    (e) => e.step === "metrics" && e.status === "start",
  )?.emittedAt;

  const span = (start?: string, end?: string): number | undefined => {
    if (!start || !end) return undefined;
    const ms = Date.parse(end) - Date.parse(start);
    return Number.isNaN(ms) ? undefined : Math.max(0, ms);
  };

  const setupMs = span(setupStart, setupEnd);
  const totalSendMs = span(sendStart, sendEnd);
  // Grading spans from metrics:start to run completion — NOT sendEnd,
  // which fires before metrics even starts (send:done is the hypothesis
  // capture, metrics:start is the judge call after it).
  const metricsEnd =
    run.progressEvents.find((e) => e.step === "metrics" && e.status === "done")
      ?.emittedAt ?? run.completedAt;
  const metricsMs = span(metricsStart, metricsEnd);

  // Ingest vs question split from the event streams.
  const ingestFirst = run.ingestAssistantEvents.find(
    (e) => e.emittedAt,
  )?.emittedAt;
  const ingestLast = (() => {
    for (let i = run.ingestAssistantEvents.length - 1; i >= 0; i--) {
      if (run.ingestAssistantEvents[i].emittedAt)
        return run.ingestAssistantEvents[i].emittedAt;
    }
    return undefined;
  })();
  const questionFirst = run.assistantEvents.find((e) => e.emittedAt)?.emittedAt;
  const questionLast = (() => {
    for (let i = run.assistantEvents.length - 1; i >= 0; i--) {
      if (run.assistantEvents[i].emittedAt)
        return run.assistantEvents[i].emittedAt;
    }
    return undefined;
  })();

  const ingestMs = span(ingestFirst, ingestLast);
  const questionMs = span(questionFirst, questionLast);

  // Only render if we have at least the total send duration.
  if (
    totalSendMs === undefined &&
    ingestMs === undefined &&
    questionMs === undefined
  ) {
    return null;
  }

  // The four labeled phases only cover the moments we can attribute to a
  // specific activity. A real run also spends wall-clock between them —
  // adapter handshakes after setup, the gap between ingest ending and the
  // question starting, process teardown before grading. That gap can be
  // minutes on a long run, so without an explicit "Other" segment the
  // labeled phases sum to far less than the total and the breakdown reads
  // as broken (e.g. Setup 91ms + Ingest 1m53s + Question 3m59s + Grading
  // 4s = 5m56s, but Total 9m06s). Other = wall-clock − Σphases tiles the
  // bar to the real total so the numbers add up.
  const wallClockMs = span(run.startedAt, run.completedAt);
  const phaseSumMs =
    (setupMs ?? 0) + (ingestMs ?? 0) + (questionMs ?? 0) + (metricsMs ?? 0);
  const otherMs =
    wallClockMs !== undefined
      ? Math.max(0, wallClockMs - phaseSumMs)
      : undefined;

  const phases: { label: string; ms: number | undefined }[] = [
    { label: "Setup", ms: setupMs },
    { label: "Ingest", ms: ingestMs },
    { label: "Question", ms: questionMs },
    { label: "Grading", ms: metricsMs },
    // Only surface Other when there's a wall-clock total to subtract
    // from AND a positive gap — otherwise it's zero/undefined and would
    // render an empty label. When the run lacks timestamps the total
    // falls back to the phase sum, so Other is correctly absent there.
    ...(otherMs !== undefined && otherMs > 0
      ? [{ label: "Other", ms: otherMs as number }]
      : []),
  ];
  // Total wall-clock from run start to completion — the real end-to-end
  // duration the labeled phases + Other must sum to. Falls back to
  // summing the phase durations only when run timestamps are unavailable.
  const totalMs = wallClockMs ?? (phaseSumMs || undefined);

  return (
    <div className="phase-timing">
      <div className="phase-timing-bar">
        {phases.map((phase) => {
          if (phase.ms === undefined || totalMs === undefined || totalMs === 0)
            return null;
          const pct = Math.max(2, (phase.ms / totalMs) * 100);
          return (
            <div
              key={phase.label}
              className={`phase-bar-segment phase-${phase.label.toLowerCase()}`}
              style={{ width: `${pct}%` }}
              title={`${phase.label}: ${formatDuration(phase.ms)}`}
            />
          );
        })}
      </div>
      <div className="phase-timing-labels">
        {phases.map((phase) => (
          <span key={phase.label} className="phase-timing-item">
            <span className={`phase-dot phase-${phase.label.toLowerCase()}`} />
            {phase.label}
            <strong>{formatDuration(phase.ms)}</strong>
          </span>
        ))}
        <span className="phase-timing-item phase-timing-total">
          Total <strong>{formatDuration(totalMs)}</strong>
        </span>
      </div>
    </div>
  );
}

function ExecutionPage({
  run,
  readOnly,
}: {
  run: ReportRunDetail;
  readOnly: boolean;
}) {
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

      <PhaseTiming run={run} />

      <CliCommandSection argv={run.cliArgv} />

      {!readOnly && (
        <div className="action-buttons">
          <details className="confirm-action">
            <summary className="bad">Delete run</summary>
            <form
              className="confirm-form"
              method="post"
              action={`/api/runs/${encodeURIComponent(run.runId)}/delete`}
            >
              <input type="hidden" name="backToSession" value={run.sessionId} />
              <p className="confirm-prompt">
                This deletes <code>{run.runId}</code> permanently. It cannot be
                undone.
              </p>
              <button className="bad" type="submit">
                Yes, delete this run
              </button>
            </form>
          </details>
        </div>
      )}

      <ExecutionTabs run={run} />
    </>
  );
}

/**
 * Expandable view of the raw request/response bodies the egress recorder
 * captured for one priced request. Returns null when the recorder wrote no
 * payloads (older runs, or a record that predates payload capture). When a
 * body was truncated past the recorder's cap, the heading notes how many of
 * the full bytes are shown so the reader knows the view is partial.
 */
function RequestPayloads({ record }: { record: Record<string, unknown> }) {
  const requestBody = readRecordString(record, "request_body");
  const responseBody = readRecordString(record, "response_body");
  if (requestBody === undefined && responseBody === undefined) return null;

  const payloadHeading = (
    label: string,
    body: string | undefined,
    truncated: boolean,
    fullBytes: number | undefined,
  ) =>
    truncated && fullBytes !== undefined && body !== undefined
      ? `${label} — showing first ${formatBytes(utf8ByteLength(body))} of ${formatBytes(fullBytes)}`
      : label;

  return (
    <details className="payload-details">
      <summary>Request &amp; response payloads</summary>
      <div className="payload-body">
        <h4>
          {payloadHeading(
            "Request",
            requestBody,
            record.request_body_truncated === true,
            readRecordNumber(record, "request_body_bytes"),
          )}
        </h4>
        <pre className="log payload-pre">{requestBody ?? "—"}</pre>
        <h4>
          {payloadHeading(
            "Response",
            responseBody,
            record.response_body_truncated === true,
            readRecordNumber(record, "response_body_bytes"),
          )}
        </h4>
        <pre className="log payload-pre">{responseBody ?? "—"}</pre>
      </div>
    </details>
  );
}

/**
 * Per-request cost breakdown for the Cost tab. One row per recorded model
 * request — model, token counts, and the dollar cost computed by the same
 * `priceUsageRecord` the run total uses — so a reader can see exactly which
 * requests drove (or didn't drive) the cost. Each row carries an expandable
 * view of the request/response payloads, which is the first place to look
 * when the cost figure looks wrong (e.g. the large agentic calls never
 * reached the recorder and only small auxiliary calls were priced).
 */
function CostRequestsTable({ usage }: { usage: UsageSummary }) {
  if (usage.requests.length === 0) return null;
  // Display newest-first. Each row keeps its chronological index (0 = first
  // request the run made), so the `#` column counts down as the reader scans
  // top-to-bottom. Order by `recorded_at` when present, falling back to array
  // position for records that carry no timestamp.
  const ordered = usage.requests
    .map((record, chronologicalIndex) => ({ record, chronologicalIndex }))
    .sort((a, b) => {
      const ta = recordedAtMs(readRecordString(a.record, "recorded_at"));
      const tb = recordedAtMs(readRecordString(b.record, "recorded_at"));
      if (ta !== undefined && tb !== undefined && ta !== tb) return tb - ta;
      return b.chronologicalIndex - a.chronologicalIndex;
    });
  return (
    <div className="cost-requests">
      <h3>Per-request breakdown</h3>
      <table className="cost-req-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache (write / read)</th>
            <th>Cost</th>
          </tr>
        </thead>
        {ordered.map(({ record, chronologicalIndex }) => {
          const priced = priceUsageRecord(record);
          const cacheWrite = readRecordNumber(
            record,
            "cache_creation_input_tokens",
          );
          const cacheRead = readRecordNumber(record, "cache_read_input_tokens");
          return (
            <tbody key={chronologicalIndex}>
              <tr>
                <td>{chronologicalIndex}</td>
                <td>
                  {formatRecordedAt(readRecordString(record, "recorded_at"))}{" "}
                  <span className="req-duration">
                    (
                    {formatRequestDuration(
                      readRecordNumber(record, "duration_ms"),
                    )}
                    )
                  </span>
                </td>
                <td>{readRecordString(record, "model") ?? "—"}</td>
                <td>
                  {formatNumber(
                    readRecordNumber(record, "input_tokens", "inputTokens"),
                    0,
                  )}
                </td>
                <td>
                  {formatNumber(
                    readRecordNumber(record, "output_tokens", "outputTokens"),
                    0,
                  )}
                </td>
                <td>
                  {formatNumber(cacheWrite, 0)} / {formatNumber(cacheRead, 0)}
                </td>
                <td>{formatCost(priced.costUsd)}</td>
              </tr>
              <tr className="payload-row">
                <td colSpan={7}>
                  <RequestPayloads record={record} />
                </td>
              </tr>
            </tbody>
          );
        })}
      </table>
    </div>
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
 * pricing table.
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
  | { kind: "profile"; profile: ReportProfileInSession }
  | { kind: "test"; test: ReportTestInSession }
  | { kind: "execution"; run: ReportRunDetail }
  | { kind: "not-found"; message: string };

function pageTitle(input: ReportPageInput): string {
  switch (input.kind) {
    case "index":
      return "Vellum Evals Report Card";
    case "session":
      return `Run · ${sessionTitle(input.session)}`;
    case "profile":
      return `Profile · ${input.profile.profileId}`;
    case "test":
      return `Test · ${input.test.testId}`;
    case "execution":
      return `Execution · ${input.run.profileId ?? ""} @ ${input.run.testId ?? ""}`;
    case "not-found":
      return "Not found · Vellum Evals";
  }
}

function PageBody({
  input,
  readOnly,
}: {
  input: ReportPageInput;
  readOnly: boolean;
}) {
  switch (input.kind) {
    case "index":
      return <IndexPage sessions={input.sessions} readOnly={readOnly} />;
    case "session":
      return <SessionPage session={input.session} />;
    case "profile":
      return <ProfileInSessionPage profile={input.profile} />;
    case "test":
      return <TestInSessionPage test={input.test} />;
    case "execution":
      return <ExecutionPage run={input.run} readOnly={readOnly} />;
    case "not-found":
      return <NotFoundPage message={input.message} />;
  }
}

function ReportDocument({
  input,
  readOnly,
}: {
  input: ReportPageInput;
  readOnly: boolean;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{pageTitle(input)}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <style
          dangerouslySetInnerHTML={{
            __html: katexCssText.replace(/@font-face\{[^}]*\}/g, ""),
          }}
        />
      </head>
      <body>
        <div className="shell">
          <PageBody input={input} readOnly={readOnly} />
        </div>
      </body>
    </html>
  );
}

export interface RenderReportOptions {
  /**
   * Suppress the mutating affordances (the delete-run / delete-all forms) so
   * the page is safe to serve as a static, read-only artifact — e.g. an
   * exported run bundle hosted on the QA dashboard, where the report-server
   * delete endpoints don't exist. Defaults to `false` (the live server).
   */
  readOnly?: boolean;
}

export function renderReportPage(
  input: ReportPageInput,
  options: RenderReportOptions = {},
): string {
  return `<!doctype html>${renderToStaticMarkup(
    <ReportDocument input={input} readOnly={options.readOnly ?? false} />,
  )}`;
}
