import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { basename } from "path";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Box, render as inkRender, Text, useInput, useStdout } from "ink";

import { removeAssistantEntry } from "../lib/assistant-config";
import { SPECIES_CONFIG, type Species } from "../lib/constants";
import { callDoctorDaemon, type ChatLogEntry } from "../lib/doctor-client";
import { checkHealth } from "../lib/health-check";
import { statusEmoji, withStatusEmoji } from "../lib/status-emoji";
import TextInput from "./TextInput";

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

export const SLASH_COMMANDS = ["/clear", "/doctor", "/exit", "/help", "/q", "/quit", "/retire"];

const POLL_INTERVAL_MS = 3000;
const SEND_TIMEOUT_MS = 5000;
const RESPONSE_POLL_INTERVAL_MS = 1000;
const RESPONSE_TIMEOUT_MS = 180000;

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
  principalKind?: string;
  principalId?: string;
  principalVersion?: string;
  persistentDecisionsAllowed?: boolean;
}

interface CreateRunResponse {
  id: string;
  status: string;
  messageId: string | null;
  createdAt: string;
}

interface GetRunResponse {
  id: string;
  status: string;
  messageId: string | null;
  pendingConfirmation: PendingConfirmation | null;
  pendingSecret: PendingSecret | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SubmitDecisionResponse {
  accepted: boolean;
}

interface AddTrustRuleResponse {
  accepted: boolean;
}

type TrustDecision = "always_allow" | "always_allow_high_risk" | "always_deny";

interface HealthResponse {
  status: string;
  message?: string;
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
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
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
      body: JSON.stringify({ conversationKey: assistantId, content }),
      signal,
    },
    bearerToken,
  );
}

async function createRun(
  baseUrl: string,
  assistantId: string,
  content: string,
  signal?: AbortSignal,
  bearerToken?: string,
): Promise<CreateRunResponse> {
  return runtimeRequest<CreateRunResponse>(
    baseUrl,
    assistantId,
    "/runs",
    {
      method: "POST",
      body: JSON.stringify({ conversationKey: assistantId, content }),
      signal,
    },
    bearerToken,
  );
}

async function getRun(
  baseUrl: string,
  assistantId: string,
  runId: string,
  bearerToken?: string,
): Promise<GetRunResponse> {
  return runtimeRequest<GetRunResponse>(
    baseUrl,
    assistantId,
    `/runs/${runId}`,
    undefined,
    bearerToken,
  );
}

async function submitDecision(
  baseUrl: string,
  assistantId: string,
  runId: string,
  decision: "allow" | "deny",
  bearerToken?: string,
): Promise<SubmitDecisionResponse> {
  return runtimeRequest<SubmitDecisionResponse>(
    baseUrl,
    assistantId,
    `/runs/${runId}/decision`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
    bearerToken,
  );
}

async function addTrustRule(
  baseUrl: string,
  assistantId: string,
  runId: string,
  pattern: string,
  scope: string,
  decision: "allow" | "deny",
  bearerToken?: string,
): Promise<AddTrustRuleResponse> {
  return runtimeRequest<AddTrustRuleResponse>(
    baseUrl,
    assistantId,
    `/runs/${runId}/trust-rule`,
    {
      method: "POST",
      body: JSON.stringify({ pattern, scope, decision }),
    },
    bearerToken,
  );
}

function formatConfirmationPreview(toolName: string, input: Record<string, unknown>): string {
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
      return input.close_all_pages ? "close all browser pages" : "close browser page";
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
  runId: string,
  confirmation: PendingConfirmation,
  chatApp: ChatAppHandle,
  bearerToken?: string,
): Promise<void> {
  const preview = formatConfirmationPreview(confirmation.toolName, confirmation.input);
  const allowlistOptions = confirmation.allowlistOptions ?? [];

  chatApp.addStatus(`\u250C ${confirmation.toolName}: ${preview}`);
  chatApp.addStatus(`\u2502 Risk: ${confirmation.riskLevel}`);
  if (confirmation.executionTarget) {
    chatApp.addStatus(`\u2502 Target: ${confirmation.executionTarget}`);
  }
  chatApp.addStatus("\u2514");

  const options = ["Allow once", "Deny once"];
  if (allowlistOptions.length > 0 && confirmation.persistentDecisionsAllowed !== false) {
    options.push("Allowlist...", "Denylist...");
  }

  const index = await chatApp.showSelection("Tool Approval", options);

  if (index === 0) {
    await submitDecision(baseUrl, assistantId, runId, "allow", bearerToken);
    chatApp.addStatus("\u2714 Allowed", "green");
    return;
  }
  if (index === 2) {
    await handlePatternSelection(
      baseUrl,
      assistantId,
      runId,
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
      runId,
      confirmation,
      chatApp,
      "always_deny",
      bearerToken,
    );
    return;
  }

  await submitDecision(baseUrl, assistantId, runId, "deny", bearerToken);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

async function handlePatternSelection(
  baseUrl: string,
  assistantId: string,
  runId: string,
  confirmation: PendingConfirmation,
  chatApp: ChatAppHandle,
  trustDecision: TrustDecision,
  bearerToken?: string,
): Promise<void> {
  const allowlistOptions = confirmation.allowlistOptions ?? [];
  const label = trustDecision === "always_deny" ? "Denylist" : "Allowlist";
  const options = allowlistOptions.map((o) => o.label);

  const index = await chatApp.showSelection(`${label}: choose command pattern`, options);

  if (index >= 0 && index < allowlistOptions.length) {
    const selectedPattern = allowlistOptions[index].pattern;
    await handleScopeSelection(
      baseUrl,
      assistantId,
      runId,
      confirmation,
      chatApp,
      selectedPattern,
      trustDecision,
      bearerToken,
    );
    return;
  }

  await submitDecision(baseUrl, assistantId, runId, "deny", bearerToken);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

async function handleScopeSelection(
  baseUrl: string,
  assistantId: string,
  runId: string,
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
      runId,
      selectedPattern,
      scopeOptions[index].scope,
      ruleDecision,
      bearerToken,
    );
    await submitDecision(
      baseUrl,
      assistantId,
      runId,
      ruleDecision === "deny" ? "deny" : "allow",
      bearerToken,
    );
    const ruleLabel = trustDecision === "always_deny" ? "Denylisted" : "Allowlisted";
    const ruleColor = trustDecision === "always_deny" ? "yellow" : "green";
    chatApp.addStatus(
      `${trustDecision === "always_deny" ? "\u2718" : "\u2714"} ${ruleLabel}`,
      ruleColor,
    );
    return;
  }

  await submitDecision(baseUrl, assistantId, runId, "deny", bearerToken);
  chatApp.addStatus("\u2718 Denied", "yellow");
}

export const TYPING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
          {"\u2502"} <Text color={statusColor}>{statusIcon}</Text> {truncateValue(tc.result, 70)}
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

export function renderErrorMainScreen(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error);
  console.log(`${ANSI.red}${ANSI.bold}Failed to render MainWindow${ANSI.reset}`);
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

  const { stdout } = useStdout();
  const terminalColumns = stdout.columns || 80;
  const totalWidth = Math.min(72, terminalColumns);
  const rightPanelWidth = Math.max(1, totalWidth - LEFT_PANEL_WIDTH);

  const tips = ["Send a message to start chatting", "Use /help to see available commands"];

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
    ...tips.map((t) => ({ text: t, style: "normal" as const })),
    { text: " ", style: "normal" },
    { text: "Assistant", style: "heading" },
    { text: assistantId, style: "dim" },
    { text: "Species", style: "heading" },
    { text: `${config.hatchedEmoji} ${species}`, style: "dim" },
    { text: "Status", style: "heading" },
    { text: withStatusEmoji(healthStatus ?? "checking..."), style: "dim" },
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <Box flexDirection="column" width={totalWidth}>
      <Text dimColor>{"── Vellum " + "─".repeat(Math.max(0, totalWidth - 10))}</Text>
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
                <Text key={i} color={accentColor}>
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
      <Text dimColor>{"─".repeat(totalWidth)}</Text>
      <Text> </Text>
      <Text dimColor> ? for shortcuts</Text>
      <Text> </Text>
    </Box>
  );
}

const LEFT_PANEL_WIDTH = 36;

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

type FeedItem = RuntimeMessage | StatusLine | SpinnerLine | HelpLine | ErrorLine;

function isRuntimeMessage(item: FeedItem): item is RuntimeMessage {
  return "role" in item;
}

function estimateItemHeight(item: FeedItem, terminalColumns: number): number {
  if (isRuntimeMessage(item)) {
    const cols = Math.max(1, terminalColumns);
    let lines = 0;
    for (const line of item.content.split("\n")) {
      lines += Math.max(1, Math.ceil(line.length / cols));
    }
    if (item.role === "assistant" && item.toolCalls) {
      for (const tc of item.toolCalls) {
        const paramCount =
          typeof tc.input === "object" && tc.input ? Object.keys(tc.input).length : 0;
        lines += 2 + paramCount + (tc.result !== undefined ? 1 : 0);
      }
    }
    return lines + 1;
  }
  if (item.type === "help") {
    return 6;
  }
  return 1;
}

function calculateHeaderHeight(species: Species): number {
  const config = SPECIES_CONFIG[species];
  const artLength = config.art.length;
  const leftLineCount = 3 + artLength + 3;
  const rightLineCount = 11;
  const maxLines = Math.max(leftLineCount, rightLineCount);
  return maxLines + 5;
}

const SCROLL_STEP = 5;

export function render(runtimeUrl: string, assistantId: string, species: Species): number {
  const config = SPECIES_CONFIG[species];
  const art = config.art;

  const leftLineCount = 3 + art.length + 3;
  const rightLineCount = 11;
  const maxLines = Math.max(leftLineCount, rightLineCount);

  const { unmount } = inkRender(
    <DefaultMainScreen runtimeUrl={runtimeUrl} assistantId={assistantId} species={species} />,
    { exitOnCtrlC: false },
  );
  unmount();

  const statusCanvasLine = rightLineCount + 1;
  const statusCol = LEFT_PANEL_WIDTH + 1;
  checkHealth(runtimeUrl)
    .then((health) => {
      const statusText = health.detail
        ? `${withStatusEmoji(health.status)} (${health.detail})`
        : withStatusEmoji(health.status);
      process.stdout.write(`\x1b7\x1b[${statusCanvasLine};${statusCol}H\x1b[K${statusText}\x1b8`);
    })
    .catch(() => {});

  return 1 + maxLines + 4;
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
        setSelectedIndex((prev: number) => (prev - 1 + options.length) % options.length);
      } else if (key.downArrow) {
        setSelectedIndex((prev: number) => (prev + 1) % options.length);
      } else if (key.return) {
        onSelect(selectedIndex);
      } else if (key.escape || (key.ctrl && input === "c")) {
        onCancel();
      }
    },
  );

  const windowWidth = 60;
  const borderH = "\u2500".repeat(Math.max(0, windowWidth - title.length - 5));

  return (
    <Box flexDirection="column" width={windowWidth}>
      <Text>{"\u250C\u2500 " + title + " " + borderH + "\u2510"}</Text>
      {options.map((option, i) => {
        const marker = i === selectedIndex ? "\u276F" : " ";
        const padding = " ".repeat(Math.max(0, windowWidth - option.length - 6));
        return (
          <Text key={i}>
            {"\u2502 "}
            <Text color={i === selectedIndex ? "cyan" : undefined}>{marker}</Text>{" "}
            <Text bold={i === selectedIndex}>{option}</Text>
            {padding}
            {"\u2502"}
          </Text>
        );
      })}
      <Text>{"\u2514" + "\u2500".repeat(windowWidth - 2) + "\u2518"}</Text>
      <Text dimColor>{"  \u2191/\u2193 navigate  Enter select  Esc cancel"}</Text>
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

  const windowWidth = 60;
  const borderH = "\u2500".repeat(Math.max(0, windowWidth - label.length - 5));
  const masked = "\u2022".repeat(value.length);
  const displayText = value.length > 0 ? masked : (placeholder ?? "Enter secret...");
  const displayColor = value.length > 0 ? undefined : "gray";
  const contentPad = " ".repeat(Math.max(0, windowWidth - displayText.length - 4));

  return (
    <Box flexDirection="column" width={windowWidth}>
      <Text>{"\u250C\u2500 " + label + " " + borderH + "\u2510"}</Text>
      <Text>
        {"\u2502 "}
        <Text color={displayColor}>{displayText}</Text>
        {contentPad}
        {"\u2502"}
      </Text>
      <Text>{"\u2514" + "\u2500".repeat(windowWidth - 2) + "\u2518"}</Text>
      <Text dimColor>{"  Enter submit  Esc cancel"}</Text>
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
    onSubmit: (value: string, delivery?: "store" | "transient_send") => Promise<void>,
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
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [spinnerText, setSpinnerText] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionRequest | null>(null);
  const [secretInput, setSecretInput] = useState<SecretInputRequest | null>(null);
  const [inputFocused, setInputFocused] = useState(true);
  const [scrollIndex, setScrollIndex] = useState<number | null>(null);
  const [healthStatus, setHealthStatus] = useState<string | undefined>(undefined);
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
  const terminalRows = stdout.rows || 24;
  const terminalColumns = stdout.columns || 80;
  const headerHeight = calculateHeaderHeight(species);
  const bottomHeight = selection
    ? selection.options.length + 3
    : secretInput
      ? 5
      : spinnerText
        ? 2
        : 3;
  const availableRows = Math.max(3, terminalRows - headerHeight - bottomHeight);

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
      let totalHeight = 0;
      let start = feed.length;
      for (let i = feed.length - 1; i >= 0; i--) {
        const h = estimateItemHeight(feed[i], terminalColumns);
        if (totalHeight + h > availableRows) {
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
    let totalHeight = 0;
    let end = start;
    for (let i = start; i < feed.length; i++) {
      const h = estimateItemHeight(feed[i], terminalColumns);
      if (totalHeight + h > availableRows) {
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
    setInputFocused(false);
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

  const showSelection = useCallback((title: string, options: string[]): Promise<number> => {
    setInputFocused(false);
    return new Promise<number>((resolve) => {
      setSelection({ title, options, resolve });
    });
  }, []);

  const showSecretInput = useCallback((label: string, placeholder?: string): Promise<string> => {
    setInputFocused(false);
    return new Promise<string>((resolve) => {
      setSecretInput({ label, placeholder, resolve });
    });
  }, []);

  const handleSecretPromptFn = useCallback(
    async (
      secret: PendingSecret,
      onSubmit: (value: string, delivery?: "store" | "transient_send") => Promise<void>,
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
    const h = handleRef_.current;

    h.showSpinner("Connecting...");

    try {
      const health = await checkHealthRuntime(runtimeUrl);
      h.hideSpinner();
      h.updateHealthStatus(health.status);
      if (health.status === "healthy" || health.status === "ok") {
        h.addStatus(`${statusEmoji(health.status)} Connected to assistant`, "green");
      } else {
        const statusMsg = health.message ? ` - ${health.message}` : "";
        h.addStatus(
          `${statusEmoji(health.status)} Assistant status: ${health.status}${statusMsg}`,
          "yellow",
        );
      }

      h.showSpinner("Loading conversation history...");

      try {
        const historyResponse = await pollMessages(runtimeUrl, assistantId, bearerToken);
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
          const response = await pollMessages(runtimeUrl, assistantId, bearerToken);
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
      return true;
    } catch {
      h.hideSpinner();
      connectingRef.current = false;
      h.updateHealthStatus("unreachable");
      h.addStatus(`${statusEmoji("unreachable")} Failed to connect: Timeout`, "red");
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
          h.showError("No instance info available. Connect to a hatched instance first.");
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
            handleRef_.current?.addStatus(`Removed ${assistantId} from lockfile.json`);
          } else {
            handleRef_.current?.showError(`Failed to delete instance (exit code ${code})`);
          }
          cleanup();
          process.exit(code === 0 ? 0 : 1);
        });

        child.on("error", (err) => {
          handleRef_.current?.hideSpinner();
          handleRef_.current?.showError(`Failed to retire instance: ${err.message}`);
        });
        return;
      }

      if (trimmed === "/doctor" || trimmed.startsWith("/doctor ")) {
        if (!project || !zone) {
          h.showError("No instance info available. Connect to a hatched instance first.");
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
                  handleRef_.current?.showSpinner(`Analyzing ${assistantId}...`);
                  break;
                case "calling_tool":
                  handleRef_.current?.showSpinner(
                    `Running ${event.toolName ?? "tool"} on ${assistantId}...`,
                  );
                  break;
                case "processing_tool_result":
                  handleRef_.current?.showSpinner(`Reviewing diagnostics for ${assistantId}...`);
                  break;
              }
            },
            doctorSessionIdRef.current,
            recentChatContext,
          );
          h.hideSpinner();
          if (result.recommendation) {
            h.addStatus(`Recommendation:\n${result.recommendation}`);
            chatLogRef.current.push({ role: "assistant", content: result.recommendation });
          } else if (result.error) {
            h.showError(result.error);
            chatLogRef.current.push({ role: "error", content: result.error });
          }
        } catch (err) {
          h.hideSpinner();
          const errorMsg = `Doctor daemon unreachable: ${err instanceof Error ? err.message : err}`;
          h.showError(errorMsg);
          chatLogRef.current.push({ role: "error", content: errorMsg });
        }
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

        let runId: string | undefined;
        try {
          const runResult = await createRun(
            runtimeUrl,
            assistantId,
            trimmed,
            controller.signal,
            bearerToken,
          );
          clearTimeout(timeoutId);
          runId = runResult.id;
        } catch (createErr) {
          clearTimeout(timeoutId);
          const is409 = createErr instanceof Error && createErr.message.includes("HTTP 409");
          if (is409) {
            h.setBusy(false);
            h.hideSpinner();
            h.showError("Assistant is still working. Please wait and try again.");
            return;
          }
          const sendResult = await sendMessage(
            runtimeUrl,
            assistantId,
            trimmed,
            undefined,
            bearerToken,
          );
          if (!sendResult.accepted) {
            h.setBusy(false);
            h.hideSpinner();
            h.showError("Message was not accepted by the assistant");
            return;
          }
        }

        h.showSpinner("Working...");

        const startTime = Date.now();
        while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
          await new Promise((resolve) => setTimeout(resolve, RESPONSE_POLL_INTERVAL_MS));

          if (runId) {
            try {
              const runStatus = await getRun(runtimeUrl, assistantId, runId, bearerToken);

              if (runStatus.status === "needs_confirmation" && runStatus.pendingConfirmation) {
                h.hideSpinner();
                await handleConfirmationPrompt(
                  runtimeUrl,
                  assistantId,
                  runId,
                  runStatus.pendingConfirmation,
                  h,
                  bearerToken,
                );
                h.showSpinner("Working...");
                continue;
              }

              if (runStatus.status === "needs_secret" && runStatus.pendingSecret) {
                h.hideSpinner();
                await h.handleSecretPrompt(runStatus.pendingSecret, async (value, delivery) => {
                  await runtimeRequest(
                    runtimeUrl,
                    assistantId,
                    `/runs/${runId}/secret`,
                    {
                      method: "POST",
                      body: JSON.stringify({ value, delivery }),
                    },
                    bearerToken,
                  );
                });
                h.showSpinner("Working...");
                continue;
              }

              if (runStatus.status === "completed") {
                try {
                  const pollResult = await pollMessages(runtimeUrl, assistantId, bearerToken);
                  for (const msg of pollResult.messages) {
                    if (!seenMessageIdsRef.current.has(msg.id)) {
                      seenMessageIdsRef.current.add(msg.id);
                      if (msg.role === "assistant") {
                        h.addMessage(msg);
                        chatLogRef.current.push({ role: "assistant", content: msg.content });
                      }
                    }
                  }
                } catch {
                  // Final poll failure; continue to cleanup
                }
                h.setBusy(false);
                h.hideSpinner();
                return;
              }

              if (runStatus.status === "failed") {
                h.setBusy(false);
                h.hideSpinner();
                const errorMsg = runStatus.error ?? "Run failed";
                h.showError(errorMsg);
                chatLogRef.current.push({ role: "error", content: errorMsg });
                return;
              }
            } catch {
              // Run status poll failure; fall through to message poll
            }
          }

          try {
            const pollResult = await pollMessages(runtimeUrl, assistantId, bearerToken);
            for (const msg of pollResult.messages) {
              if (!seenMessageIdsRef.current.has(msg.id)) {
                seenMessageIdsRef.current.add(msg.id);
                if (msg.role === "assistant") {
                  h.addMessage(msg);
                  chatLogRef.current.push({ role: "assistant", content: msg.content });
                  if (!runId) {
                    h.setBusy(false);
                    h.hideSpinner();
                    return;
                  }
                }
              }
            }
          } catch {
            // Poll failure; retry
          }
        }

        h.setBusy(false);
        h.hideSpinner();
        h.showError("Response timed out. The assistant may still be processing.");
        try {
          const doctorResult = await callDoctorDaemon(
            assistantId,
            project,
            zone,
            undefined,
            undefined,
            doctorSessionIdRef.current,
          );
          if (doctorResult.diagnostics) {
            h.addStatus(
              `--- SSH Diagnostics ---\n${doctorResult.diagnostics}\n--- End Diagnostics ---`,
            );
          }
        } catch {
          // Doctor daemon unreachable; skip diagnostics
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
          const is409 = error instanceof Error && error.message.includes("HTTP 409");
          if (is409) {
            h.showError("Assistant is still working. Please wait and try again.");
          } else {
            const errorMsg = `Failed to send: ${error instanceof Error ? error.message : error}`;
            h.showError(errorMsg);
            chatLogRef.current.push({ role: "error", content: errorMsg });
          }
        }
      }
    },
    [runtimeUrl, assistantId, bearerToken, project, zone, cleanup, ensureConnected],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      setInputValue("");
      handleInput(value);
    },
    [handleInput],
  );

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

  return (
    <Box flexDirection="column" height={terminalRows}>
      <DefaultMainScreen
        runtimeUrl={runtimeUrl}
        assistantId={assistantId}
        species={species}
        healthStatus={healthStatus}
      />

      {visibleWindow.hiddenAbove > 0 ? (
        <Text dimColor>
          {"\u2191"} {visibleWindow.hiddenAbove} more above (Shift+\u2191/Cmd+\u2191)
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
            <Text key={feedIndex} color={item.color as "green" | "yellow" | "red" | undefined}>
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
          {"\u2193"} {visibleWindow.hiddenBelow} more below (Shift+\u2193/Cmd+\u2193)
        </Text>
      ) : null}

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
        <Box flexDirection="column">
          <Text dimColor>{"\u2500".repeat(terminalColumns)}</Text>
          <Box paddingLeft={1}>
            <Text color="green" bold>
              you{">"}
            {" "}
          </Text>
          <TextInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            focus={inputFocused}
          />
          </Box>
          <Text dimColor>{"\u2500".repeat(terminalColumns)}</Text>
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
