import { type ReactElement } from "react";
import { Box, render as inkRender, Text } from "ink";
import { basename } from "path";

import { SPECIES_CONFIG, type Species } from "../lib/constants";
import { checkHealth } from "../lib/health-check";
import { withStatusEmoji } from "../lib/status-emoji";

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

export const TYPING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: unknown[];
}

export function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function renderMessage(msg: RuntimeMessage): void {
  const time = formatTimestamp(msg.timestamp);
  const timeStr = time ? `${ANSI.gray}${time}${ANSI.reset} ` : "";

  if (msg.role === "user") {
    console.log(`${timeStr}${ANSI.green}${ANSI.bold}You:${ANSI.reset} ${msg.content}`);
  } else {
    console.log(`${timeStr}${ANSI.cyan}${ANSI.bold}Assistant:${ANSI.reset} ${msg.content}`);
    if (msg.toolCalls && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        const call = tc as Record<string, unknown>;
        const name = typeof call.name === "string" ? call.name : "unknown";
        console.log(`  ${ANSI.dim}[tool: ${name}]${ANSI.reset}`);
      }
    }
  }
}

export function renderHelp(): void {
  console.log(`${ANSI.bold}Commands:${ANSI.reset}`);
  console.log(
    `  /doctor [question] ${ANSI.dim}Run diagnostics on the remote instance via SSH${ANSI.reset}`,
  );
  console.log(`  /retire           ${ANSI.dim}Retire the remote instance and exit${ANSI.reset}`);
  console.log(`  /quit, /exit, /q  ${ANSI.dim}Disconnect and exit${ANSI.reset}`);
  console.log(`  /clear            ${ANSI.dim}Clear the screen${ANSI.reset}`);
  console.log(`  /help, ?          ${ANSI.dim}Show this help${ANSI.reset}`);
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
}

function DefaultMainScreen({
  runtimeUrl,
  assistantId,
  species,
}: DefaultMainScreenProps): ReactElement {
  const cwd = process.cwd();
  const dirName = basename(cwd);
  const config = SPECIES_CONFIG[species];
  const art = config.art;
  const accentColor = species === "openclaw" ? "red" : "magenta";

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

  const rightLines = [
    " ",
    "Tips for getting started",
    ...tips,
    " ",
    "Assistant",
    assistantId,
    "Species",
    `${config.hatchedEmoji} ${species}`,
    "Status",
    withStatusEmoji("checking..."),
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);

  return (
    <Box flexDirection="column" width={72}>
      <Text dimColor>{"── Vellum " + "─".repeat(62)}</Text>
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
        <Box flexDirection="column">
          {Array.from({ length: maxLines }, (_, i) => {
            const line = rightLines[i] ?? " ";
            const isHeading = i === 1 || i === 6;
            const isDim = i === 5 || i === 7 || i === 9;
            if (isHeading) {
              return (
                <Text key={i} color={accentColor}>
                  {line}
                </Text>
              );
            }
            if (isDim) {
              return (
                <Text key={i} dimColor>
                  {line}
                </Text>
              );
            }
            return <Text key={i}>{line}</Text>;
          })}
        </Box>
      </Box>
      <Text dimColor>{"─".repeat(72)}</Text>
      <Text> </Text>
      <Text dimColor> ? for shortcuts</Text>
      <Text> </Text>
    </Box>
  );
}

const LEFT_PANEL_WIDTH = 36;

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
