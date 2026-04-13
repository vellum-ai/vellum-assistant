import { spawn } from "child_process";
import { createHash, randomBytes, randomUUID } from "crypto";
import { hostname, userInfo } from "os";
import { basename } from "path";
import qrcode from "qrcode-terminal";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Box, render as inkRender, Text, useInput, useStdout } from "ink";

import { removeAssistantEntry } from "../lib/assistant-config";
import { SPECIES_CONFIG, type Species } from "../lib/constants";
import { callDoctorDaemon, type ChatLogEntry } from "../lib/doctor-client";
import { checkHealth } from "../lib/health-check";
import { appendHistory, loadHistory } from "../lib/input-history";
import { statusEmoji, withStatusEmoji } from "../lib/status-emoji";
import {
  getTerminalCapabilities,
  unicodeOrFallback,
} from "../lib/terminal-capabilities";
import TextInput from "./TextInput";
import { Tooltip } from "./Tooltip";

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
} as const;

export const SLASH_COMMANDS = [
  "/btw",
  "/clear",
  "/doctor",
  "/exit",
  "/help",
  "/pair",
  "/q",
  "/quit",
  "/retire",
];

const POLL_INTERVAL_MS = 3000;
const SEND_TIMEOUT_MS = 5000;
const RESPONSE_POLL_INTERVAL_MS = 1000;

// ── Layout constants ──────────────────────────────────────
const MAX_TOTAL_WIDTH = 72;
const DEFAULT_TERMINAL_COLUMNS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const LEFT_PANEL_WIDTH = 36;

const COMPACT_THRESHOLD = 60;
const HEADER_PREFIX_UNICODE = "── Vellum ";
const HEADER_PREFIX_ASCII = "-- Vellum ";

// Left panel structure: HEADER lines + art + FOOTER lines
const LEFT_HEADER_LINES = 3; // spacer + heading + spacer
const LEFT_FOOTER_LINES = 3; // spacer + runtimeUrl + dirName

// Right panel structure
const TIPS = [
  "Send a message to start chatting",
  "Use /help to see available commands",
];
const RIGHT_PANEL_INFO_SECTIONS = 3; // Assistant, Species, Status — each with heading + value
const RIGHT_PANEL_SPACERS = 2; // top spacer + spacer between tips and info
const RIGHT_PANEL_TIPS_HEADING = 1;
const RIGHT_PANEL_LINE_COUNT =
  RIGHT_PANEL_SPACERS +
  RIGHT_PANEL_TIPS_HEADING +
  TIPS.length +
  RIGHT_PANEL_INFO_SECTIONS * 2;

// Header chrome (borders around panel content)
const HEADER_TOP_BORDER_LINES = 1; // "── Vellum ───..." line
const HEADER_BOTTOM_BORDER_LINES = 2; // bottom rule + blank line
const HEADER_CHROME_LINES =
  HEADER_TOP_BORDER_LINES + HEADER_BOTTOM_BORDER_LINES;

// Selection / Secret windows
const DIALOG_WINDOW_WIDTH = 60;
const DIALOG_TITLE_CHROME = 5; // "┌─ " (3) + " " (1) + "┐" (1)
const DIALOG_BORDER_CORNERS = 2; // └ and ┘
const SELECTION_OPTION_CHROME = 6; // "│ " (2) + marker (1) + " " (1) + padding‐adjust + "│" (1)
const SECRET_CONTENT_CHROME = 4; // "│ " (2) + padding + "│" (1) + adjustment

// Chat area heights
const TOOLTIP_HEIGHT = 3;
const INPUT_AREA_HEIGHT = 4; // separator + input row + separator + hint
const SELECTION_CHROME_LINES = 3; // title bar + bottom border + spacing
const SECRET_INPUT_HEIGHT = 5; // title bar + content row + bottom border + tooltip chrome
const SPINNER_HEIGHT = 1;
const MIN_FEED_ROWS = 3;

// Feed item height estimation
const TOOL_CALL_CHROME_LINES = 2; // header (┌) + footer (└)
const MESSAGE_SPACING = 1;
const HELP_DISPLAY_HEIGHT = 8;

interface ListMessagesResponse {
  messages: RuntimeMessage[];
  nextCursor?: string;
  interfaces?: string[];
}

interface SendMessageResponse {
  accepted: boolean;
  messageId: string;
}

interface AllowlistOption {
  label: string;
  pattern: string;
}

interface ScopeOption {
  label: string;
  scope: string;
}

interface PendingConfirmation {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  riskLevel: string;
  executionTarget?: "sandbox" | "host";
  allowlistOptions?: AllowlistOption[];
  scopeOptions?: ScopeOption[];
  persistentDecisionsAllowed?: boolean;
}

interface SubmitDecisionResponse {
  accepted: boolean;
}

interface AddTrustRuleResponse {
  accepted: boolean;
}

interface PendingInteractionsResponse {
  pendingConfirmation: (PendingConfirmation & { requestId: string }) | null;
  pendingSecret: (PendingSecret & { requestId?: string }) | null;
}

type TrustDecision = "always_allow" | "always_deny";

interface HealthResponse {
  status: string;
  message?: string;
}

/** Extract human-readable message from a daemon JSON error response. */
function friendlyErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Not JSON — fall through
  }
  return `HTTP ${status}: ${body || "Unknown error"}`;
}

async function runtimeRequest<T>(
  baseUrl: string,
  assistantId: string,
  path: string,
  init?: RequestInit,
  bearerToken?: string,
): Promise<T> {
  const url = `${baseUrl}/v1/assistants/${assistantId}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(friendlyErrorMessage(response.status, body));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function checkHealthRuntime(baseUrl: string): Promise<HealthResponse> {
  const url = `${baseUrl}/healthz`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  const response = await fetch(url, {
    signal: controller.signal,
    headers: { "Content-Type": "application/json" },
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<HealthResponse>;
}

async function pollMessages(
  baseUrl: string,
  assistantId: string,
  bearerToken?: string,
): Promise<ListMessagesResponse> {
  const params = new URLSearchParams({ conversationKey: assistantId });
  return runtimeRequest<ListMessagesResponse>(
    baseUrl,
    assistantId,
    `/messages?${params.toString()}`,
    undefined,
    bearerToken,
  );
}

async function sendMessage(
  baseUrl: string,
  assistantId: string,
  content: string,
  signal?: AbortSignal,
  bearerToken?: string,
): Promise<SendMessageResponse> {
  return runtimeRequest<SendMessageResponse>(
    baseUrl,
    assistantId,
    "/messages",
    {
      method: "POST",
      body: JSON.stringify({
        conversationKey: assistantId,
        content,
        sourceChannel: "vellum",
        interface: "cli",
      }),
      signal,
    },
    bearerToken,
  );
}

async function submitDecision(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  decision: "allow" | "deny",
  bearerToken?: string,
): Promise<SubmitDecisionResponse> {
  return runtimeRequest<SubmitDecisionResponse>(
    baseUrl,
    assistantId,
    "/confirm",
    {
      method: "POST",
      body: JSON.stringify({ requestId, decision }),
    },
    bearerToken,
  );
}

async function addTrustRule(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  pattern: string,
  scope: string,
  decision: "allow" | "deny",
  bearerToken?: string,
): Promise<AddTrustRuleResponse> {
  return runtimeRequest<AddTrustRuleResponse>(
    baseUrl,
    assistantId,
    "/trust-rules",
    {
      method: "POST",
      body: JSON.stringify({ requestId, pattern, scope, decision }),
    },
    bearerToken,
  );
}

async function pollPendingInteractions(
  baseUrl: string,
  assistantId: string,
  bearerToken?: string,
): Promise<PendingInteractionsResponse> {
  const params = new URLSearchParams({ conversationKey: assistantId });
  return runtimeRequest<PendingInteractionsResponse>(
    baseUrl,
    assistantId,
    `/pending-interactions?${params.toString()}`,
    undefined,
    bearerToken,
  );
}

function formatConfirmationPreview(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "bash":
      return String(input.command ?? "");
    case "file_read":
      return `read ${input.path ?? ""}`;
    case "file_write":
      return `write ${input.path ?? ""}`;
    case "file_edit":
      return `edit ${input.path ?? ""}`;
    case "web_fetch":
      return String(input.url ?? "").slice(0, 80);
    case "browser_navigate":
      return `navigate ${String(input.url ?? "").slice(0, 80)}`;
    case "browser_close":
      return input.close_all_pages
        ? "close all browser pages"
        : "close browser page";
    case "browser_click":
      return `click ${input.element_id ?? input.selector ?? ""}`;
    case "browser_type":
      return `type into ${input.element_id ?? input.selector ?? ""}`;
    case "browser_press_key":
      return `press "${input.key ?? ""}"`;
    default:
      return `${toolName}: ${JSON.stringify(input).slice(0, 80)}`;
  }
}

async function handleConfirmationPrompt(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  confirmation: PendingConfirmation,
  chatApp: ChatAppHandle,
  bearerToken?: string,
): Promise<void> {
  const preview = formatConfirmationPreview(
    confirmation.toolName,
    confirmation.input,
  );
  const allowlistOptions = confirmation.allowlistOptions ?? [];

  chatApp.addStatus(`\u250C ${confirmation.toolName}: ${preview}`);
  chatApp.addStatus(`\u2502 Risk: ${confirmation.riskLevel}`);
  if (confirmation.executionTarget) {
    chatApp.addStatus(`\u2502 Target: ${confirmation.executionTarget}`);
  }
  chatApp.addStatus("\u2514");

  const options = ["Allow once", "Deny once"];
  if (
    allowlistOptions.length > 0 &&
    confirmation.persistentDecisionsAllowed !== false
  ) {
    options.push("Allowlist...", "Denylist...");
  }

  const index = await chatApp.showSelection("Tool Approval", options);

  if (index === 0) {
    await submitDecision(baseUrl, assistantId, requestId, "allow", bearerToken);
    chatApp.addStatus("\u2714 Allowed", "green");
    return;
  }
  if (index === 2) {
    await handlePatternSelection(
      baseUrl,
      assistantId,
      requestId,
      confirmation,
      chatApp,
      "always_allow",
      bearerToken,
    );
    return;
  }
  if (index === 3) {
    await handlePatternSelection(
      baseUrl,
      assistantId,
      requestId,
      confirmation,
      chatApp,
      "always_deny",
      bearerToken,
    );
    return;
  }

  await submitDecision(baseUrl, assistantId, requestId, "deny", bearerToken);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

async function handlePatternSelection(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  confirmation: PendingConfirmation,
  chatApp: ChatAppHandle,
  trustDecision: TrustDecision,
  bearerToken?: string,
): Promise<void> {
  const allowlistOptions = confirmation.allowlistOptions ?? [];
  const label = trustDecision === "always_deny" ? "Denylist" : "Allowlist";
  const options = allowlistOptions.map((o) => o.label);

  const index = await chatApp.showSelection(
    `${label}: choose command pattern`,
    options,
  );

  if (index >= 0 && index < allowlistOptions.length) {
    const selectedPattern = allowlistOptions[index].pattern;
    await handleScopeSelection(
      baseUrl,
      assistantId,
      requestId,
      confirmation,
      chatApp,
      selectedPattern,
      trustDecision,
      bearerToken,
    );
    return;
  }

  await submitDecision(baseUrl, assistantId, requestId, "deny", bearerToken);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

async function handleScopeSelection(
  baseUrl: string,
  assistantId: string,
  requestId: string,
  confirmation: PendingConfirmation,
  chatApp: ChatAppHandle,
  selectedPattern: string,
  trustDecision: TrustDecision,
  bearerToken?: string,
): Promise<void> {
  const scopeOptions = confirmation.scopeOptions ?? [];
  const label = trustDecision === "always_deny" ? "Denylist" : "Allowlist";
  const options = scopeOptions.map((o) => o.label);

  const index = await chatApp.showSelection(`${label}: choose scope`, options);

  if (index >= 0 && index < scopeOptions.length) {
    const ruleDecision = trustDecision === "always_deny" ? "deny" : "allow";
    await addTrustRule(
      baseUrl,
      assistantId,
      requestId,
      selectedPattern,
      scopeOptions[index].scope,
      ruleDecision,
      bearerToken,
    );
    await submitDecision(
      baseUrl,
      assistantId,
      requestId,
      ruleDecision === "deny" ? "deny" : "allow",
      bearerToken,
    );
    const ruleLabel =
      trustDecision === "always_deny" ? "Denylisted" : "Allowlisted";
    const ruleColor = trustDecision === "always_deny" ? "yellow" : "green";
    chatApp.addStatus(
      `${trustDecision === "always_deny" ? "\u2718" : "\u2714"} ${ruleLabel}`,
      ruleColor,
    );
    return;
  }

  await submitDecision(baseUrl, assistantId, requestId, "deny", bearerToken);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

export const TYPING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** ASCII-safe spinner frames for the connection screen. */
const CONNECTION_SPINNER_FRAMES = ["|", "/", "-", "\\"];

export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: ToolCallInfo[];
  label?: string;
}

export function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatToolCallPreview(tc: ToolCallInfo): string {
  switch (tc.name) {
    case "bash":
      return String(tc.input.command ?? "").slice(0, 80);
    case "file_read":
      return `read ${tc.input.path ?? ""}`;
    case "file_write":
      return `write ${tc.input.path ?? ""}`;
    case "file_edit":
      return `edit ${tc.input.path ?? ""}`;
    case "web_search":
      return String(tc.input.query ?? "").slice(0, 80);
    case "web_fetch":
      return String(tc.input.url ?? "").slice(0, 80);
    case "browser_navigate":
      return `navigate ${String(tc.input.url ?? "").slice(0, 80)}`;
    case "browser_click":
      return `click ${String(tc.input.element_id ?? tc.input.selector ?? "").slice(0, 60)}`;
    case "browser_type":
      return `type into ${String(tc.input.element_id ?? tc.input.selector ?? "").slice(0, 60)}`;
    default:
      return JSON.stringify(tc.input).slice(0, 80);
  }
}

function truncateValue(value: unknown, maxLen: number): string {
  if (typeof value === "string") {
    if (value.length > maxLen) {
      return value.slice(0, maxLen - 3) + "...";
    }
    return value;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > maxLen) {
    return serialized.slice(0, maxLen - 3) + "...";
  }
  return serialized;
}

interface ToolCallDisplayProps {
  tc: ToolCallInfo;
}

function ToolCallDisplay({ tc }: ToolCallDisplayProps): ReactElement {
  const preview = formatToolCallPreview(tc);
  const statusIcon = tc.isError ? "\u2718" : "\u2714";
  const statusColor = tc.isError ? "red" : "green";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text dimColor>
        {"\u250C"} {tc.name}: {preview}
      </Text>
      {typeof tc.input === "object" && tc.input
        ? Object.entries(tc.input).map(([key, value]) => (
            <Text key={key} dimColor>
              {"\u2502"} {key}: {truncateValue(value, 70)}
            </Text>
          ))
        : null}
      {tc.result !== undefined ? (
        <Text dimColor>
          {"\u2502"} <Text color={statusColor}>{statusIcon}</Text>{" "}
          {truncateValue(tc.result, 70)}
        </Text>
      ) : null}
      <Text dimColor>{"\u2514"}</Text>
    </Box>
  );
}

interface MessageDisplayProps {
  msg: RuntimeMessage;
}

function MessageDisplay({ msg }: MessageDisplayProps): ReactElement {
  const time = formatTimestamp(msg.timestamp);
  const defaultLabel = msg.role === "user" ? "You:" : "Assistant:";
  const label = msg.label ?? defaultLabel;
  const labelColor = msg.role === "user" ? "green" : "cyan";

  return (
    <Box flexDirection="column">
      <Text>
        {time ? <Text dimColor>{time} </Text> : null}
        <Text color={labelColor} bold>
          {label}{" "}
        </Text>
        <Text>{msg.content}</Text>
      </Text>
      {msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0
        ? msg.toolCalls.map((tc, i) => <ToolCallDisplay key={i} tc={tc} />)
        : null}
    </Box>
  );
}

function HelpDisplay(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>Commands:</Text>
      <Text>
        {"  /btw <question>   "}
        <Text dimColor>Ask a side question while the assistant is working</Text>
      </Text>
      <Text>
        {"  /doctor [question] "}
        <Text dimColor>Run diagnostics on the remote instance via SSH</Text>
      </Text>
      <Text>
        {"  /retire           "}
        <Text dimColor>Retire the remote instance and exit</Text>
      </Text>
      <Text>
        {"  /quit, /exit, /q  "}
        <Text dimColor>Disconnect and exit</Text>
      </Text>
      <Text>
        {"  /clear            "}
        <Text dimColor>Clear the screen</Text>
      </Text>
      <Text>
        {"  /pair             "}
        <Text dimColor>Generate a QR code for mobile device pairing</Text>
      </Text>
      <Text>
        {"  /help, ?          "}
        <Text dimColor>Show this help</Text>
      </Text>
    </Box>
  );
}

function SpinnerDisplay({ text }: { text: string }): ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % TYPING_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text dimColor>
      {TYPING_FRAMES[frameIndex]} {text}
    </Text>
  );
}

type ConnectionState = "connecting" | "connected" | "error";

function ConnectionScreen({
  state,
  errorMessage,
  species,
  terminalRows,
  terminalColumns,
  onRetry,
  onExit,
}: {
  state: ConnectionState;
  errorMessage?: string;
  species: Species;
  terminalRows: number;
  terminalColumns: number;
  onRetry: () => void;
  onExit: () => void;
}): ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (state !== "connecting") return;
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % CONNECTION_SPINNER_FRAMES.length);
    }, 150);
    return () => clearInterval(timer);
  }, [state]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onExit();
    }
    if (state === "error" && input === "r") {
      onRetry();
    }
  });

  const config = SPECIES_CONFIG[species];
  const title = `Vellum ${config.hatchedEmoji} ${species}`;
  const width = Math.min(terminalColumns, MAX_TOTAL_WIDTH);

  return (
    <Box
      flexDirection="column"
      height={terminalRows}
      width={width}
      justifyContent="center"
      alignItems="center"
    >
      <Text dimColor bold>
        {title}
      </Text>
      <Text> </Text>
      {state === "connecting" ? (
        <Text dimColor>
          {CONNECTION_SPINNER_FRAMES[frameIndex]} Connecting to assistant...
        </Text>
      ) : (
        <>
          <Text color="red">Failed to connect: {errorMessage}</Text>
          <Text> </Text>
          <Text dimColor>Press r to retry or Ctrl+C to quit</Text>
        </>
      )}
    </Box>
  );
}

export function renderErrorMainScreen(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(
    `${ANSI.red}${ANSI.bold}Failed to render MainWindow${ANSI.reset}`,
  );
  console.log(`${ANSI.dim}${msg}${ANSI.reset}`);
  console.log(`${ANSI.dim}Run /clear to retry${ANSI.reset}`);
  return 3;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

interface DefaultMainScreenProps {
  runtimeUrl: string;
  assistantId: string;
  species: Species;
  healthStatus?: string;
}

interface StyledLine {
  text: string;
  style: "heading" | "dim" | "normal";
}

function CompactHeader({
  species,
  healthStatus,
  totalWidth,
}: {
  species: Species;
  healthStatus?: string;
  totalWidth: number;
}): ReactElement {
  const config = SPECIES_CONFIG[species];
  const accentColor = species === "openclaw" ? "red" : "magenta";
  const status = healthStatus ?? "checking...";
  const label = ` ${config.hatchedEmoji} ${species} ${statusEmoji(status)} `;
  const prefix = "── Vellum";
  const suffix = "──";
  const fillLen = Math.max(
    0,
    totalWidth - prefix.length - label.length - suffix.length,
  );
  return (
    <Box flexDirection="column" width={totalWidth}>
      <Text dimColor>
        {prefix}
        <Text color={accentColor}>{label}</Text>
        {"─".repeat(fillLen)}
        {suffix}
      </Text>
    </Box>
  );
}

function DefaultMainScreen({
  runtimeUrl,
  assistantId,
  species,
  healthStatus,
}: DefaultMainScreenProps): ReactElement {
  const cwd = process.cwd();
  const dirName = basename(cwd);
  const config = SPECIES_CONFIG[species];
  const art = config.art;
  const accentColor = species === "openclaw" ? "red" : "magenta";
  const caps = getTerminalCapabilities();
  const headerPrefix = caps.unicodeSupported
    ? HEADER_PREFIX_UNICODE
    : HEADER_PREFIX_ASCII;
  const headerSep = caps.unicodeSupported ? "─" : "-";

  const { stdout } = useStdout();
  const terminalColumns = stdout.columns || DEFAULT_TERMINAL_COLUMNS;
  const totalWidth = Math.min(MAX_TOTAL_WIDTH, terminalColumns);
  const isCompact = terminalColumns < COMPACT_THRESHOLD;

  if (isCompact) {
    return (
      <CompactHeader
        species={species}
        healthStatus={healthStatus}
        totalWidth={totalWidth}
      />
    );
  }

  const rightPanelWidth = Math.max(1, totalWidth - LEFT_PANEL_WIDTH);

  const leftLines = [
    " ",
    "    Meet your Assistant!",
    " ",
    ...art.map((l) => `  ${stripAnsi(l)}`),
    " ",
    `  ${runtimeUrl}`,
    `  ~/${dirName}`,
  ];

  const rightLines: StyledLine[] = [
    { text: " ", style: "normal" },
    { text: "Tips for getting started", style: "heading" },
    ...TIPS.map((t) => ({ text: t, style: "normal" as const })),
    { text: " ", style: "normal" },
    { text: "Assistant", style: "heading" },
    { text: assistantId, style: "dim" },
    { text: "Species", style: "heading" },
    {
      text: `${unicodeOrFallback(config.hatchedEmoji, `[${species}]`)} ${species}`,
      style: "dim",
    },
    { text: "Status", style: "heading" },
    { text: withStatusEmoji(healthStatus ?? "checking..."), style: "dim" },
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <Box flexDirection="column" width={totalWidth}>
      <Text dimColor>
        {headerPrefix +
          headerSep.repeat(Math.max(0, totalWidth - headerPrefix.length))}
      </Text>
      <Box flexDirection="row">
        <Box flexDirection="column" width={LEFT_PANEL_WIDTH}>
          {Array.from({ length: maxLines }, (_, i) => {
            const line = leftLines[i] ?? " ";
            if (i === 1) {
              return (
                <Text key={i} bold>
                  {line}
                </Text>
              );
            }
            if (i > 2 && i <= 2 + art.length) {
              return (
                <Text key={i} color={caps.isDumb ? undefined : accentColor}>
                  {line}
                </Text>
              );
            }
            if (i > 2 + art.length) {
              return (
                <Text key={i} dimColor>
                  {line}
                </Text>
              );
            }
            return <Text key={i}>{line}</Text>;
          })}
        </Box>
        <Box flexDirection="column" width={rightPanelWidth}>
          {Array.from({ length: maxLines }, (_, i) => {
            const item = rightLines[i];
            if (!item) return <Text key={i}> </Text>;
            if (item.style === "heading") {
              return (
                <Text key={i} color={accentColor}>
                  {item.text}
                </Text>
              );
            }
            if (item.style === "dim") {
              return (
                <Text key={i} dimColor>
                  {item.text}
                </Text>
              );
            }
            return <Text key={i}>{item.text}</Text>;
          })}
        </Box>
      </Box>
      <Text dimColor>{headerSep.repeat(totalWidth)}</Text>
      <Text> </Text>
    </Box>
  );
}

export interface SelectionRequest {
  title: string;
  options: string[];
  resolve: (index: number) => void;
}

interface StatusLine {
  type: "status";
  text: string;
  color?: string;
}

interface SpinnerLine {
  type: "spinner";
  text: string;
}

interface HelpLine {
  type: "help";
}

interface ErrorLine {
  type: "error";
  text: string;
}

type FeedItem =
  | RuntimeMessage
  | StatusLine
  | SpinnerLine
  | HelpLine
  | ErrorLine;

function isRuntimeMessage(item: FeedItem): item is RuntimeMessage {
  return "role" in item;
}

function estimateItemHeight(item: FeedItem, terminalColumns: number): number {
  if (isRuntimeMessage(item)) {
    const cols = Math.max(1, terminalColumns);
    // Account for "HH:MM AM Label: " prefix on the first line
    const defaultLabel = item.role === "user" ? "You:" : "Assistant:";
    const label = item.label ?? defaultLabel;
    const prefixLen = 10 + label.length + 1; // timestamp + space + label + space
    let lines = 0;
    const contentLines = item.content.split("\n");
    for (let idx = 0; idx < contentLines.length; idx++) {
      const lineLen =
        idx === 0
          ? contentLines[idx].length + prefixLen
          : contentLines[idx].length;
      lines += Math.max(1, Math.ceil(lineLen / cols));
    }
    if (item.role === "assistant" && item.toolCalls) {
      for (const tc of item.toolCalls) {
        const paramCount =
          typeof tc.input === "object" && tc.input
            ? Object.keys(tc.input).length
            : 0;
        lines +=
          TOOL_CALL_CHROME_LINES +
          paramCount +
          (tc.result !== undefined ? 1 : 0);
      }
    }
    return lines + MESSAGE_SPACING;
  }
  if (item.type === "help") {
    return HELP_DISPLAY_HEIGHT;
  }
  if (item.type === "status" || item.type === "error") {
    const cols = Math.max(1, terminalColumns);
    let lines = 0;
    for (const line of item.text.split("\n")) {
      lines += Math.max(1, Math.ceil(line.length / cols));
    }
    return lines;
  }
  return 1;
}

const COMPACT_HEADER_HEIGHT = 1;

function calculateHeaderHeight(
  species: Species,
  terminalColumns?: number,
): number {
  if ((terminalColumns ?? DEFAULT_TERMINAL_COLUMNS) < COMPACT_THRESHOLD) {
    return COMPACT_HEADER_HEIGHT;
  }
  const config = SPECIES_CONFIG[species];
  const artLength = config.art.length;
  const leftLineCount = LEFT_HEADER_LINES + artLength + LEFT_FOOTER_LINES;
  const maxLines = Math.max(leftLineCount, RIGHT_PANEL_LINE_COUNT);
  return maxLines + HEADER_CHROME_LINES;
}

const SCROLL_STEP = 5;

export function render(
  runtimeUrl: string,
  assistantId: string,
  species: Species,
): number {
  const terminalColumns = process.stdout.columns || DEFAULT_TERMINAL_COLUMNS;
  const isCompact = terminalColumns < COMPACT_THRESHOLD;

  const config = SPECIES_CONFIG[species];
  const art = config.art;

  const leftLineCount = LEFT_HEADER_LINES + art.length + LEFT_FOOTER_LINES;
  const maxLines = Math.max(leftLineCount, RIGHT_PANEL_LINE_COUNT);

  const { unmount } = inkRender(
    <DefaultMainScreen
      runtimeUrl={runtimeUrl}
      assistantId={assistantId}
      species={species}
    />,
    { exitOnCtrlC: false },
  );
  unmount();

  if (isCompact) {
    return COMPACT_HEADER_HEIGHT;
  }

  const statusCanvasLine = RIGHT_PANEL_LINE_COUNT + HEADER_TOP_BORDER_LINES;
  const statusCol = LEFT_PANEL_WIDTH + 1;
  checkHealth(runtimeUrl)
    .then((health) => {
      const statusText = health.detail
        ? `${withStatusEmoji(health.status)} (${health.detail})`
        : withStatusEmoji(health.status);
      process.stdout.write(
        `\x1b7\x1b[${statusCanvasLine};${statusCol}H\x1b[K${statusText}\x1b8`,
      );
    })
    .catch(() => {});

  return maxLines + HEADER_CHROME_LINES;
}

interface SelectionWindowProps {
  title: string;
  options: string[];
  onSelect: (index: number) => void;
  onCancel: () => void;
}

function SelectionWindow({
  title,
  options,
  onSelect,
  onCancel,
}: SelectionWindowProps): ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (
      input: string,
      key: {
        upArrow: boolean;
        downArrow: boolean;
        return: boolean;
        escape: boolean;
        ctrl: boolean;
      },
    ) => {
      if (key.upArrow) {
        setSelectedIndex(
          (prev: number) => (prev - 1 + options.length) % options.length,
        );
      } else if (key.downArrow) {
        setSelectedIndex((prev: number) => (prev + 1) % options.length);
      } else if (key.return) {
        onSelect(selectedIndex);
      } else if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      }
    },
  );

  const borderH = "\u2500".repeat(
    Math.max(0, DIALOG_WINDOW_WIDTH - title.length - DIALOG_TITLE_CHROME),
  );

  return (
    <Box flexDirection="column" width={DIALOG_WINDOW_WIDTH}>
      <Text>{"\u250C\u2500 " + title + " " + borderH + "\u2510"}</Text>
      {options.map((option, i) => {
        const marker = i === selectedIndex ? "\u276F" : " ";
        const padding = " ".repeat(
          Math.max(
            0,
            DIALOG_WINDOW_WIDTH - option.length - SELECTION_OPTION_CHROME,
          ),
        );
        return (
          <Text key={i}>
            {"\u2502 "}
            <Text color={i === selectedIndex ? "cyan" : undefined}>
              {marker}
            </Text>{" "}
            <Text bold={i === selectedIndex}>{option}</Text>
            {padding}
            {"\u2502"}
          </Text>
        );
      })}
      <Text>
        {"\u2514" +
          "\u2500".repeat(DIALOG_WINDOW_WIDTH - DIALOG_BORDER_CORNERS) +
          "\u2518"}
      </Text>
      <Tooltip
        text="\u2191/\u2193 navigate  Enter select  Esc cancel"
        delay={1000}
      />
    </Box>
  );
}

interface SecretInputWindowProps {
  label: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function SecretInputWindow({
  label,
  placeholder,
  onSubmit,
  onCancel,
}: SecretInputWindowProps): ReactElement {
  const [value, setValue] = useState("");

  useInput(
    (
      input: string,
      key: {
        return: boolean;
        escape: boolean;
        ctrl: boolean;
        backspace: boolean;
        delete: boolean;
      },
    ) => {
      if (key.return) {
        onSubmit(value);
      } else if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      } else if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl) {
        setValue((prev) => prev + input);
      }
    },
  );

  const borderH = "\u2500".repeat(
    Math.max(0, DIALOG_WINDOW_WIDTH - label.length - DIALOG_TITLE_CHROME),
  );
  const masked = "\u2022".repeat(value.length);
  const displayText =
    value.length > 0 ? masked : (placeholder ?? "Enter secret...");
  const displayColor = value.length > 0 ? undefined : "gray";
  const contentPad = " ".repeat(
    Math.max(
      0,
      DIALOG_WINDOW_WIDTH - displayText.length - SECRET_CONTENT_CHROME,
    ),
  );

  return (
    <Box flexDirection="column" width={DIALOG_WINDOW_WIDTH}>
      <Text>{"\u250C\u2500 " + label + " " + borderH + "\u2510"}</Text>
      <Text>
        {"\u2502 "}
        <Text color={displayColor}>{displayText}</Text>
        {contentPad}
        {"\u2502"}
      </Text>
      <Text>
        {"\u2514" +
          "\u2500".repeat(DIALOG_WINDOW_WIDTH - DIALOG_BORDER_CORNERS) +
          "\u2518"}
      </Text>
      <Tooltip text="Enter submit  Esc cancel" delay={1000} />
    </Box>
  );
}

export interface SecretInputRequest {
  label: string;
  placeholder?: string;
  resolve: (value: string) => void;
}

export interface PendingSecret {
  requestId: string;
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  purpose?: string;
  allowOneTimeSend?: boolean;
}

export interface ChatAppHandle {
  addMessage: (msg: RuntimeMessage) => void;
  addStatus: (text: string, color?: string) => void;
  showSpinner: (text: string) => void;
  hideSpinner: () => void;
  showHelp: () => void;
  showError: (text: string) => void;
  showSelection: (title: string, options: string[]) => Promise<number>;
  showSecretInput: (label: string, placeholder?: string) => Promise<string>;
  handleSecretPrompt: (
    secret: PendingSecret,
    onSubmit: (
      value: string,
      delivery?: "store" | "transient_send",
    ) => Promise<void>,
  ) => Promise<void>;
  clearFeed: () => void;
  setBusy: (busy: boolean) => void;
  updateHealthStatus: (status: string) => void;
}

interface ChatAppProps {
  runtimeUrl: string;
  assistantId: string;
  species: Species;
  bearerToken?: string;
  project?: string;
  zone?: string;
  onExit: () => void;
  handleRef: (handle: ChatAppHandle) => void;
}

function ChatApp({
  runtimeUrl,
  assistantId,
  species,
  bearerToken,
  project,
  zone,
  onExit,
  handleRef,
}: ChatAppProps): ReactElement {
  const [inputValue, setInputValue] = useState("");
  const historyRef = useRef<string[]>(loadHistory());
  const historyIndexRef = useRef(-1);
  const savedInputRef = useRef("");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [spinnerText, setSpinnerText] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionRequest | null>(null);
  const [secretInput, setSecretInput] = useState<SecretInputRequest | null>(
    null,
  );
  const [inputFocused, setInputFocused] = useState(true);
  const [scrollIndex, setScrollIndex] = useState<number | null>(null);
  const [healthStatus, setHealthStatus] = useState<string | undefined>(
    undefined,
  );
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | undefined>(
    undefined,
  );
  const prevFeedLengthRef = useRef(0);
  const busyRef = useRef(false);
  const connectedRef = useRef(false);
  const connectingRef = useRef(false);
  const seenMessageIdsRef = useRef(new Set<string>());
  const chatLogRef = useRef<ChatLogEntry[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doctorSessionIdRef = useRef(randomUUID());
  const handleRef_ = useRef<ChatAppHandle | null>(null);

  const { stdout } = useStdout();
  const terminalRows = stdout.rows || DEFAULT_TERMINAL_ROWS;
  const terminalColumns = stdout.columns || DEFAULT_TERMINAL_COLUMNS;
  const headerHeight = calculateHeaderHeight(species, terminalColumns);

  const isCompact = terminalColumns < COMPACT_THRESHOLD;
  const compactInputAreaHeight = 1; // input row only, no separators
  const inputAreaHeight = isCompact
    ? compactInputAreaHeight
    : INPUT_AREA_HEIGHT;
  const bottomHeight = selection
    ? selection.options.length + SELECTION_CHROME_LINES + TOOLTIP_HEIGHT
    : secretInput
      ? SECRET_INPUT_HEIGHT + TOOLTIP_HEIGHT
      : spinnerText
        ? SPINNER_HEIGHT + inputAreaHeight
        : inputAreaHeight;
  const availableRows = Math.max(
    MIN_FEED_ROWS,
    terminalRows - headerHeight - bottomHeight,
  );

  const addMessage = useCallback((msg: RuntimeMessage) => {
    setFeed((prev) => [...prev, msg]);
    if (msg.role === "assistant" && !busyRef.current) {
      setSpinnerText(null);
      setInputFocused(true);
    }
  }, []);

  useEffect(() => {
    if (feed.length > prevFeedLengthRef.current && scrollIndex === null) {
      prevFeedLengthRef.current = feed.length;
    } else if (feed.length > prevFeedLengthRef.current) {
      prevFeedLengthRef.current = feed.length;
    } else if (feed.length === 0) {
      prevFeedLengthRef.current = 0;
      setScrollIndex(null);
    }
  }, [feed.length, scrollIndex]);

  const visibleWindow = useMemo(() => {
    if (feed.length === 0) {
      return {
        items: [] as FeedItem[],
        startIndex: 0,
        endIndex: 0,
        hiddenAbove: 0,
        hiddenBelow: 0,
      };
    }

    if (scrollIndex === null) {
      // Reserve 1 line for "N more above" indicator when there are hidden messages
      let totalHeight = 0;
      let start = feed.length;
      for (let i = feed.length - 1; i >= 0; i--) {
        const h = estimateItemHeight(feed[i], terminalColumns);
        // Reserve space for the "more above" indicator if we'd hide messages
        const indicatorLine = i > 0 ? 1 : 0;
        if (totalHeight + h + indicatorLine > availableRows) {
          break;
        }
        totalHeight += h;
        start = i;
      }
      if (start === feed.length && feed.length > 0) {
        start = feed.length - 1;
      }
      return {
        items: feed.slice(start, feed.length),
        startIndex: start,
        endIndex: feed.length,
        hiddenAbove: start,
        hiddenBelow: 0,
      };
    }

    const start = Math.max(0, Math.min(scrollIndex, feed.length - 1));
    // Reserve lines for "more above/below" indicators
    const aboveIndicator = start > 0 ? 1 : 0;
    const budget = availableRows - aboveIndicator;
    let totalHeight = 0;
    let end = start;
    for (let i = start; i < feed.length; i++) {
      const h = estimateItemHeight(feed[i], terminalColumns);
      // Reserve space for "more below" indicator if we'd hide messages
      const belowIndicator = i + 1 < feed.length ? 1 : 0;
      if (totalHeight + h + belowIndicator > budget) {
        break;
      }
      totalHeight += h;
      end = i + 1;
    }
    return {
      items: feed.slice(start, end),
      startIndex: start,
      endIndex: end,
      hiddenAbove: start,
      hiddenBelow: feed.length - end,
    };
  }, [feed, scrollIndex, availableRows, terminalColumns]);

  const addStatus = useCallback((text: string, color?: string) => {
    const item: StatusLine = { type: "status", text, color };
    setFeed((prev) => [...prev, item]);
  }, []);

  const showSpinner = useCallback((text: string) => {
    setSpinnerText(text);
  }, []);

  const hideSpinner = useCallback(() => {
    setSpinnerText(null);
    setInputFocused(true);
  }, []);

  const showHelpFn = useCallback(() => {
    const item: HelpLine = { type: "help" };
    setFeed((prev) => [...prev, item]);
  }, []);

  const showError = useCallback((text: string) => {
    const item: ErrorLine = { type: "error", text };
    setFeed((prev) => [...prev, item]);
  }, []);

  const showSelection = useCallback(
    (title: string, options: string[]): Promise<number> => {
      setInputFocused(false);
      return new Promise<number>((resolve) => {
        setSelection({ title, options, resolve });
      });
    },
    [],
  );

  const showSecretInput = useCallback(
    (label: string, placeholder?: string): Promise<string> => {
      setInputFocused(false);
      return new Promise<string>((resolve) => {
        setSecretInput({ label, placeholder, resolve });
      });
    },
    [],
  );

  const handleSecretPromptFn = useCallback(
    async (
      secret: PendingSecret,
      onSubmit: (
        value: string,
        delivery?: "store" | "transient_send",
      ) => Promise<void>,
    ): Promise<void> => {
      addStatus(`\u250C Secret needed: ${secret.label}`);
      addStatus(`\u2502 Service: ${secret.service} / ${secret.field}`);
      if (secret.description) {
        addStatus(`\u2502 ${secret.description}`);
      }
      if (secret.purpose) {
        addStatus(`\u2502 Purpose: ${secret.purpose}`);
      }
      addStatus("\u2514");

      let delivery: "store" | "transient_send" | undefined;
      if (secret.allowOneTimeSend) {
        const deliveryIndex = await showSelection("Secret delivery", [
          "Store securely",
          "Send once (transient)",
        ]);
        if (deliveryIndex === 1) {
          delivery = "transient_send";
        } else {
          delivery = "store";
        }
      }

      const value = await showSecretInput(secret.label, secret.placeholder);

      if (!value) {
        try {
          await onSubmit("", delivery);
        } catch {
          // Best-effort
        }
        addStatus("\u2718 Cancelled", "yellow");
        return;
      }

      try {
        await onSubmit(value, delivery);
        addStatus("\u2714 Secret submitted", "green");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showError(`Failed to submit secret: ${msg}`);
      }
    },
    [addStatus, showSelection, showSecretInput, showError],
  );

  const setBusy = useCallback((busy: boolean) => {
    busyRef.current = busy;
    if (!busy) {
      setSpinnerText(null);
      setInputFocused(true);
    }
  }, []);

  const clearFeed = useCallback(() => {
    setFeed([]);
    setSpinnerText(null);
    setSelection(null);
    setSecretInput(null);
    setInputFocused(true);
    setScrollIndex(null);
    busyRef.current = false;
  }, []);

  const updateHealthStatus = useCallback((status: string) => {
    setHealthStatus(status);
  }, []);

  const cleanup = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  const ensureConnected = useCallback(async (): Promise<boolean> => {
    if (connectedRef.current) {
      return true;
    }
    if (connectingRef.current || !handleRef_.current) {
      return false;
    }
    connectingRef.current = true;
    setConnectionState("connecting");
    setConnectionError(undefined);
    const h = handleRef_.current;

    h.showSpinner("Connecting...");

    try {
      const health = await checkHealthRuntime(runtimeUrl);
      h.hideSpinner();
      h.updateHealthStatus(health.status);
      if (health.status === "healthy" || health.status === "ok") {
        h.addStatus(
          `${statusEmoji(health.status)} Connected to assistant`,
          "green",
        );
      } else {
        const statusMsg = health.message ? ` - ${health.message}` : "";
        h.addStatus(
          `${statusEmoji(health.status)} Assistant status: ${health.status}${statusMsg}`,
          "yellow",
        );
      }

      h.showSpinner("Loading conversation history...");

      try {
        const historyResponse = await pollMessages(
          runtimeUrl,
          assistantId,
          bearerToken,
        );
        h.hideSpinner();
        if (historyResponse.messages.length > 0) {
          for (const msg of historyResponse.messages) {
            h.addMessage(msg);
            seenMessageIdsRef.current.add(msg.id);
          }
        }
      } catch {
        h.hideSpinner();
      }

      pollTimerRef.current = setInterval(async () => {
        try {
          const response = await pollMessages(
            runtimeUrl,
            assistantId,
            bearerToken,
          );
          for (const msg of response.messages) {
            if (!seenMessageIdsRef.current.has(msg.id)) {
              seenMessageIdsRef.current.add(msg.id);
              if (msg.role === "assistant") {
                handleRef_.current?.addMessage(msg);
              }
            }
          }
        } catch {
          // Poll failure; continue silently
        }
      }, POLL_INTERVAL_MS);

      connectedRef.current = true;
      connectingRef.current = false;
      setConnectionState("connected");
      return true;
    } catch (err) {
      h.hideSpinner();
      connectingRef.current = false;
      h.updateHealthStatus("unreachable");
      const msg = err instanceof Error ? err.message : String(err);
      setConnectionState("error");
      setConnectionError(msg);
      h.addStatus(
        `${statusEmoji("unreachable")} Failed to connect: ${msg}`,
        "red",
      );
      return false;
    }
  }, [runtimeUrl, assistantId, bearerToken]);

  const handleInput = useCallback(
    async (input: string): Promise<void> => {
      const h = handleRef_.current;
      if (!h) {
        return;
      }

      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
        cleanup();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        h.clearFeed();
        return;
      }

      if (trimmed === "/help" || trimmed === "?") {
        h.showHelp();
        return;
      }

      if (trimmed === "/retire") {
        if (!project || !zone) {
          h.showError(
            "No instance info available. Connect to a hatched instance first.",
          );
          return;
        }

        const confirmIndex = await h.showSelection(`Retire ${assistantId}?`, [
          "Yes, retire",
          "Cancel",
        ]);
        if (confirmIndex !== 0) {
          h.addStatus("Cancelled.");
          return;
        }

        h.showSpinner(`Retiring instance ${assistantId}...`);

        try {
          const labelChild = spawn(
            "gcloud",
            [
              "compute",
              "instances",
              "add-labels",
              assistantId,
              `--project=${project}`,
              `--zone=${zone}`,
              "--labels=retired-by=vel",
            ],
            { stdio: "pipe" },
          );
          await new Promise<void>((resolve) => {
            labelChild.on("close", () => resolve());
            labelChild.on("error", () => resolve());
          });
        } catch {
          // Best-effort labeling before deletion
        }

        const child = spawn(
          "gcloud",
          [
            "compute",
            "instances",
            "delete",
            assistantId,
            `--project=${project}`,
            `--zone=${zone}`,
            "--quiet",
          ],
          { stdio: "pipe" },
        );

        child.on("close", (code) => {
          handleRef_.current?.hideSpinner();
          if (code === 0) {
            removeAssistantEntry(assistantId);
            handleRef_.current?.addStatus(
              `Removed ${assistantId} from lockfile.json`,
            );
          } else {
            handleRef_.current?.showError(
              `Failed to delete instance (exit code ${code})`,
            );
          }
          cleanup();
          process.exit(code === 0 ? 0 : 1);
        });

        child.on("error", (err) => {
          handleRef_.current?.hideSpinner();
          handleRef_.current?.showError(
            `Failed to retire instance: ${err.message}`,
          );
        });
        return;
      }

      if (trimmed === "/doctor" || trimmed.startsWith("/doctor ")) {
        if (!project || !zone) {
          h.showError(
            "No instance info available. Connect to a hatched instance first.",
          );
          return;
        }
        const userPrompt = trimmed.slice("/doctor".length).trim() || undefined;
        const recentChatContext = chatLogRef.current.slice(-20);

        chatLogRef.current.push({ role: "user", content: trimmed });

        if (userPrompt) {
          const doctorUserMsg: RuntimeMessage = {
            id: "local-user-" + Date.now(),
            role: "user",
            content: userPrompt,
            timestamp: new Date().toISOString(),
            label: "You (to Doctor):",
          };
          h.addMessage(doctorUserMsg);
        }

        h.showSpinner(`Analyzing ${assistantId}...`);

        try {
          const result = await callDoctorDaemon(
            assistantId,
            project,
            zone,
            userPrompt,
            (event) => {
              switch (event.phase) {
                case "invoking_prompt":
                  handleRef_.current?.showSpinner(
                    `Analyzing ${assistantId}...`,
                  );
                  break;
                case "calling_tool":
                  handleRef_.current?.showSpinner(
                    `Running ${event.toolName ?? "tool"} on ${assistantId}...`,
                  );
                  break;
                case "processing_tool_result":
                  handleRef_.current?.showSpinner(
                    `Reviewing diagnostics for ${assistantId}...`,
                  );
                  break;
              }
            },
            doctorSessionIdRef.current,
            recentChatContext,
          );
          h.hideSpinner();
          if (result.recommendation) {
            h.addStatus(`Recommendation:\n${result.recommendation}`);
            chatLogRef.current.push({
              role: "assistant",
              content: result.recommendation,
            });
          } else if (result.error) {
            h.showError(result.error);
            chatLogRef.current.push({ role: "error", content: result.error });
          }
        } catch (err) {
          h.hideSpinner();
          const errorMsg = `Doctor assistant unreachable: ${err instanceof Error ? err.message : err}`;
          h.showError(errorMsg);
          chatLogRef.current.push({ role: "error", content: errorMsg });
        }
        return;
      }

      // If a connection attempt is already in progress, don't silently drop input
      if (connectingRef.current) {
        h.addStatus(
          "Still connecting — please wait a moment and try again.",
          "yellow",
        );
        return;
      }

      if (trimmed.startsWith("/btw ")) {
        const question = trimmed.slice(5).trim();
        if (!question) return;

        h.addStatus(`/btw ${question}`, "gray");

        const isConnected = await ensureConnected();
        if (!isConnected) return;

        try {
          const res = await fetch(
            `${runtimeUrl}/v1/assistants/${assistantId}/btw`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(bearerToken
                  ? { Authorization: `Bearer ${bearerToken}` }
                  : {}),
              },
              body: JSON.stringify({
                conversationKey: assistantId,
                content: question,
              }),
              signal: AbortSignal.timeout(30_000),
            },
          );

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          let fullText = "";
          let sseError = "";
          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          if (reader) {
            let buffer = "";
            let currentEvent = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (line.startsWith("event: ")) {
                  currentEvent = line.slice(7).trim();
                } else if (line.startsWith("data: ")) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    if (currentEvent === "btw_error" || data.error) {
                      sseError = data.error ?? data.text ?? "Unknown error";
                    } else if (data.text) {
                      fullText += data.text;
                    }
                  } catch {
                    /* skip malformed */
                  }
                } else if (line.trim() === "") {
                  // Empty line marks end of SSE event; reset event type
                  currentEvent = "";
                }
              }
            }
          }
          if (sseError) {
            h.showError(`/btw: ${sseError}`);
          } else {
            h.addStatus(fullText || "No response");
          }
        } catch (err) {
          h.showError(
            `/btw failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        return;
      }

      if (trimmed === "/pair") {
        h.showSpinner("Generating pairing credentials...");

        const isConnected = await ensureConnected();
        if (!isConnected) {
          h.hideSpinner();
          h.showError("Cannot pair — not connected to the assistant runtime.");
          return;
        }

        try {
          const pairingRequestId = randomUUID();
          const pairingSecret = randomBytes(32).toString("hex");
          const gatewayUrl = runtimeUrl;

          // Call /pairing/register on the gateway (dedicated pairing proxy route)
          const registerUrl = `${runtimeUrl}/pairing/register`;
          const registerRes = await fetch(registerUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(bearerToken
                ? { Authorization: `Bearer ${bearerToken}` }
                : {}),
            },
            body: JSON.stringify({
              pairingRequestId,
              pairingSecret,
              gatewayUrl,
            }),
          });

          if (!registerRes.ok) {
            const body = await registerRes.text().catch(() => "");
            throw new Error(
              `HTTP ${registerRes.status}: ${body || registerRes.statusText}`,
            );
          }

          let username: string;
          try {
            username = userInfo().username;
          } catch {
            username = "";
          }
          const hostId = createHash("sha256")
            .update(hostname() + username)
            .digest("hex");
          const payload = JSON.stringify({
            type: "vellum-assistant",
            v: 4,
            id: hostId,
            g: gatewayUrl,
            pairingRequestId,
            pairingSecret,
          });

          const qrString = await new Promise<string>((resolve) => {
            qrcode.generate(payload, { small: true }, (code: string) => {
              resolve(code);
            });
          });

          h.hideSpinner();
          h.addStatus(
            `Pairing Ready\n\n` +
              `Scan this QR code with the Vellum iOS app:\n\n` +
              `${qrString}\n` +
              `This pairing request expires in 5 minutes. Run /pair again to generate a new one.`,
          );
        } catch (err) {
          h.hideSpinner();
          h.showError(
            `Pairing failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        return;
      }

      if (busyRef.current) {
        // /btw is already handled above this block
        if (!trimmed.startsWith("/")) {
          const userMsg: RuntimeMessage = {
            id: "local-user-" + Date.now(),
            role: "user",
            content: trimmed,
            timestamp: new Date().toISOString(),
          };
          h.addMessage(userMsg);
        }
        const isConnected = await ensureConnected();
        if (!isConnected) {
          h.showError("Cannot send — not connected to the assistant.");
          setInputFocused(true);
          return;
        }
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            SEND_TIMEOUT_MS,
          );
          const sendResult = await sendMessage(
            runtimeUrl,
            assistantId,
            trimmed,
            controller.signal,
            bearerToken,
          );
          clearTimeout(timeoutId);
          if (sendResult.accepted) {
            chatLogRef.current.push({ role: "user", content: trimmed });
            h.addStatus(
              "Message queued — will be processed after current response",
              "gray",
            );
          } else {
            h.showError("Message was not accepted by the assistant");
          }
        } catch (err) {
          h.showError(
            `Failed to queue message: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        setInputFocused(true);
        return;
      }

      if (!trimmed.startsWith("/")) {
        const userMsg: RuntimeMessage = {
          id: "local-user-" + Date.now(),
          role: "user",
          content: trimmed,
          timestamp: new Date().toISOString(),
        };
        h.addMessage(userMsg);
      }

      const isConnected = await ensureConnected();
      if (!isConnected) {
        return;
      }

      chatLogRef.current.push({ role: "user", content: trimmed });
      seenMessageIdsRef.current.add("pending-user-" + Date.now());

      h.showSpinner("Sending...");
      h.setBusy(true);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

        try {
          const sendResult = await sendMessage(
            runtimeUrl,
            assistantId,
            trimmed,
            controller.signal,
            bearerToken,
          );
          clearTimeout(timeoutId);
          if (!sendResult.accepted) {
            h.setBusy(false);
            h.hideSpinner();
            h.showError("Message was not accepted by the assistant");
            return;
          }
        } catch (sendErr) {
          clearTimeout(timeoutId);
          h.setBusy(false);
          h.hideSpinner();
          const errorMsg =
            sendErr instanceof Error ? sendErr.message : String(sendErr);
          h.showError(errorMsg);
          chatLogRef.current.push({ role: "error", content: errorMsg });
          return;
        }

        h.showSpinner("Working...");

        while (true) {
          await new Promise((resolve) =>
            setTimeout(resolve, RESPONSE_POLL_INTERVAL_MS),
          );

          // Check for pending confirmations/secrets
          try {
            const pending = await pollPendingInteractions(
              runtimeUrl,
              assistantId,
              bearerToken,
            );

            if (pending.pendingConfirmation) {
              h.hideSpinner();
              await handleConfirmationPrompt(
                runtimeUrl,
                assistantId,
                pending.pendingConfirmation.requestId,
                pending.pendingConfirmation,
                h,
                bearerToken,
              );
              h.showSpinner("Working...");
              continue;
            }

            if (pending.pendingSecret) {
              const secretRequestId = pending.pendingSecret.requestId ?? "";
              h.hideSpinner();
              await h.handleSecretPrompt(
                pending.pendingSecret,
                async (value, delivery) => {
                  await runtimeRequest(
                    runtimeUrl,
                    assistantId,
                    "/secret",
                    {
                      method: "POST",
                      body: JSON.stringify({
                        requestId: secretRequestId,
                        value,
                        delivery,
                      }),
                    },
                    bearerToken,
                  );
                },
              );
              h.showSpinner("Working...");
              continue;
            }
          } catch {
            // Pending interactions poll failure; fall through to message poll
          }

          // Poll for new messages to detect completion
          try {
            const pollResult = await pollMessages(
              runtimeUrl,
              assistantId,
              bearerToken,
            );
            for (const msg of pollResult.messages) {
              if (!seenMessageIdsRef.current.has(msg.id)) {
                seenMessageIdsRef.current.add(msg.id);
                if (msg.role === "assistant") {
                  h.addMessage(msg);
                  chatLogRef.current.push({
                    role: "assistant",
                    content: msg.content,
                  });
                  process.stdout.write("\x07");
                  h.setBusy(false);
                  h.hideSpinner();
                  return;
                }
              }
            }
          } catch {
            // Poll failure; retry
          }
        }
      } catch (error) {
        h.setBusy(false);
        h.hideSpinner();
        const isTimeout = error instanceof Error && error.name === "AbortError";
        if (isTimeout) {
          const errorMsg = "Send timed out";
          h.showError(errorMsg);
          chatLogRef.current.push({ role: "error", content: errorMsg });
        } else {
          const errorMsg = `Failed to send: ${error instanceof Error ? error.message : error}`;
          h.showError(errorMsg);
          chatLogRef.current.push({ role: "error", content: errorMsg });
        }
      }
    },
    [
      runtimeUrl,
      assistantId,
      bearerToken,
      project,
      zone,
      cleanup,
      ensureConnected,
    ],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed) {
        appendHistory(trimmed);
        historyRef.current = loadHistory();
      }
      historyIndexRef.current = -1;
      savedInputRef.current = "";
      setInputValue("");
      handleInput(value);
    },
    [handleInput],
  );

  const handleHistoryUp = useCallback(() => {
    const history = historyRef.current;
    if (history.length === 0) return;
    if (historyIndexRef.current === -1) {
      savedInputRef.current = inputValue;
    }
    const nextIndex = Math.min(historyIndexRef.current + 1, history.length - 1);
    historyIndexRef.current = nextIndex;
    const entry = history[history.length - 1 - nextIndex];
    setInputValue(entry);
  }, [inputValue]);

  const handleHistoryDown = useCallback(() => {
    if (historyIndexRef.current === -1) return;
    if (historyIndexRef.current <= 0) {
      historyIndexRef.current = -1;
      setInputValue(savedInputRef.current);
      return;
    }
    historyIndexRef.current -= 1;
    const history = historyRef.current;
    const entry = history[history.length - 1 - historyIndexRef.current];
    setInputValue(entry);
  }, []);

  useEffect(() => {
    const handle: ChatAppHandle = {
      addMessage,
      addStatus,
      showSpinner,
      hideSpinner,
      showHelp: showHelpFn,
      showError,
      showSelection,
      showSecretInput,
      handleSecretPrompt: handleSecretPromptFn,
      clearFeed,
      setBusy,
      updateHealthStatus,
    };
    handleRef_.current = handle;
    handleRef(handle);
  }, [
    handleRef,
    addMessage,
    addStatus,
    showSpinner,
    hideSpinner,
    showHelpFn,
    showError,
    showSelection,
    showSecretInput,
    handleSecretPromptFn,
    clearFeed,
    setBusy,
    updateHealthStatus,
  ]);

  const retryConnection = useCallback(() => {
    if (connectingRef.current) return; // already retrying
    connectedRef.current = false;
    setConnectionState("connecting");
    ensureConnected();
  }, [ensureConnected]);

  useEffect(() => {
    ensureConnected();
  }, [ensureConnected]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onExit();
      }
    },
    { isActive: inputFocused },
  );

  useInput(
    (_input, key) => {
      if (key.shift && key.upArrow) {
        setScrollIndex((prev) => {
          if (prev === null) {
            return Math.max(0, visibleWindow.startIndex - SCROLL_STEP);
          }
          return Math.max(0, prev - SCROLL_STEP);
        });
      } else if (key.shift && key.downArrow) {
        setScrollIndex((prev) => {
          if (prev === null) {
            return null;
          }
          const nextIndex = prev + SCROLL_STEP;
          let totalHeight = 0;
          for (let i = nextIndex; i < feed.length; i++) {
            totalHeight += estimateItemHeight(feed[i], terminalColumns);
            if (totalHeight > availableRows) {
              return nextIndex;
            }
          }
          return null;
        });
      } else if (key.meta && key.upArrow) {
        setScrollIndex(0);
      } else if (key.meta && key.downArrow) {
        setScrollIndex(null);
      }
    },
    { isActive: !selection && !secretInput },
  );

  const handleSecretSubmit = useCallback(
    (value: string) => {
      if (secretInput) {
        const { resolve } = secretInput;
        setSecretInput(null);
        setInputFocused(true);
        resolve(value);
      }
    },
    [secretInput],
  );

  const handleSecretCancel = useCallback(() => {
    if (secretInput) {
      const { resolve } = secretInput;
      setSecretInput(null);
      setInputFocused(true);
      resolve("");
    }
  }, [secretInput]);

  const handleSelectionSelect = useCallback(
    (index: number) => {
      if (selection) {
        const { resolve } = selection;
        setSelection(null);
        setInputFocused(true);
        resolve(index);
      }
    },
    [selection],
  );

  const handleSelectionCancel = useCallback(() => {
    if (selection) {
      const { resolve } = selection;
      setSelection(null);
      setInputFocused(true);
      resolve(-1);
    }
  }, [selection]);

  if (connectionState !== "connected") {
    return (
      <ConnectionScreen
        state={connectionState}
        errorMessage={connectionError}
        species={species}
        terminalRows={terminalRows}
        terminalColumns={terminalColumns}
        onRetry={retryConnection}
        onExit={onExit}
      />
    );
  }

  return (
    <Box flexDirection="column" height={terminalRows}>
      <DefaultMainScreen
        runtimeUrl={runtimeUrl}
        assistantId={assistantId}
        species={species}
        healthStatus={healthStatus}
      />

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleWindow.hiddenAbove > 0 ? (
          <Text dimColor>
            {isCompact
              ? `\u2191 ${visibleWindow.hiddenAbove} more above`
              : `\u2191 ${visibleWindow.hiddenAbove} more above (Shift+\u2191/Cmd+\u2191)`}
          </Text>
        ) : null}

        {visibleWindow.items.map((item, i) => {
          const feedIndex = visibleWindow.startIndex + i;
          if (isRuntimeMessage(item)) {
            return (
              <Box key={feedIndex} flexDirection="column" marginBottom={1}>
                <MessageDisplay msg={item} />
              </Box>
            );
          }
          if (item.type === "status") {
            return (
              <Text
                key={feedIndex}
                color={item.color as "green" | "yellow" | "red" | undefined}
              >
                {item.text}
              </Text>
            );
          }
          if (item.type === "help") {
            return <HelpDisplay key={feedIndex} />;
          }
          if (item.type === "error") {
            return (
              <Text key={feedIndex} color="red">
                {item.text}
              </Text>
            );
          }
          return null;
        })}

        {visibleWindow.hiddenBelow > 0 ? (
          <Text dimColor>
            {"\u2193"} {visibleWindow.hiddenBelow} more below
            (Shift+\u2193/Cmd+\u2193)
          </Text>
        ) : null}
      </Box>

      {spinnerText ? <SpinnerDisplay text={spinnerText} /> : null}

      {selection ? (
        <SelectionWindow
          title={selection.title}
          options={selection.options}
          onSelect={handleSelectionSelect}
          onCancel={handleSelectionCancel}
        />
      ) : null}

      {secretInput ? (
        <SecretInputWindow
          label={secretInput.label}
          placeholder={secretInput.placeholder}
          onSubmit={handleSecretSubmit}
          onCancel={handleSecretCancel}
        />
      ) : null}

      {!selection && !secretInput ? (
        <Box flexDirection="column" flexShrink={0}>
          {isCompact ? null : (
            <Text dimColor>
              {unicodeOrFallback("\u2500", "-").repeat(terminalColumns)}
            </Text>
          )}
          <Box paddingLeft={isCompact ? 0 : 1} height={1} flexShrink={0}>
            <Text color="green" bold>
              {isCompact ? ">" : "you>"}
              {" "}
            </Text>
            <TextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              onHistoryUp={handleHistoryUp}
              onHistoryDown={handleHistoryDown}
              completionCommands={SLASH_COMMANDS}
              focus={inputFocused}
            />
          </Box>
          {terminalColumns >= COMPACT_THRESHOLD ? (
            <>
              <Text dimColor>
                {unicodeOrFallback("\u2500", "-").repeat(terminalColumns)}
              </Text>
              <Text dimColor> ? for shortcuts</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export interface ChatAppInstance {
  handle: ChatAppHandle;
  unmount: () => void;
}

export function renderChatApp(
  runtimeUrl: string,
  assistantId: string,
  species: Species,
  onExit: () => void,
  options?: { bearerToken?: string; project?: string; zone?: string },
): ChatAppInstance {
  let chatHandle: ChatAppHandle | null = null;

  const instance = inkRender(
    <ChatApp
      runtimeUrl={runtimeUrl}
      assistantId={assistantId}
      species={species}
      bearerToken={options?.bearerToken}
      project={options?.project}
      zone={options?.zone}
      onExit={onExit}
      handleRef={(h) => {
        chatHandle = h;
      }}
    />,
    { exitOnCtrlC: false },
  );

  const handle: ChatAppHandle = {
    addMessage: (msg) => chatHandle?.addMessage(msg),
    addStatus: (text, color) => chatHandle?.addStatus(text, color),
    showSpinner: (text) => chatHandle?.showSpinner(text),
    hideSpinner: () => chatHandle?.hideSpinner(),
    showHelp: () => chatHandle?.showHelp(),
    showError: (text) => chatHandle?.showError(text),
    showSelection: (title, options) =>
      chatHandle?.showSelection(title, options) ?? Promise.resolve(-1),
    showSecretInput: (label, placeholder) =>
      chatHandle?.showSecretInput(label, placeholder) ?? Promise.resolve(""),
    handleSecretPrompt: (secret, onSubmitCb) =>
      chatHandle?.handleSecretPrompt(secret, onSubmitCb) ?? Promise.resolve(),
    clearFeed: () => chatHandle?.clearFeed(),
    setBusy: (busy) => chatHandle?.setBusy(busy),
    updateHealthStatus: (status) => chatHandle?.updateHealthStatus(status),
  };

  return {
    handle,
    unmount: () => instance.unmount(),
  };
}
