import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import QRCode from "qrcode";

import type { InterfaceId } from "../channels/types.js";
import { getGatewayPort, getIngressPublicBaseUrl } from "../config/env.js";
import { getConfig } from "../config/loader.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { getConfiguredProviders } from "../providers/provider-availability.js";
import { getLocalIPv4 } from "../util/network-info.js";
import { getWorkspaceDir } from "../util/platform.js";
import { silentlyWithLog } from "../util/silently.js";
import type { PairingStore } from "./pairing-store.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "unknown"; message: string; qrFilename?: string }
  | { kind: "compact" };

// ── /pair command — module-level pairing context ────────────────────

let pairingStoreRef: PairingStore | null = null;

/**
 * Initialise the pairing context so the /pair slash command can register
 * pairing requests directly (synchronous, no HTTP round-trip).
 * Called once from the daemon lifecycle after the RuntimeHttpServer starts.
 */
export function initSlashPairingContext(store: PairingStore): void {
  pairingStoreRef = store;
}

// ── /status command ──────────────────────────────────────────────────

export interface SlashContext {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  maxInputTokens: number;
  model: string;
  provider: string;
  estimatedCost: number;
  userMessageInterface?: InterfaceId;
}

// ── Deprecated model-switching shortcuts ─────────────────────────────

/**
 * Former provider shortcut commands that switched models. These are now
 * removed — model switching lives in Settings. We reject them explicitly
 * so they don't fall through to the LLM as passthrough text.
 */
const DEPRECATED_MODEL_SHORTCUTS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "grok-beta",
  "grok-multi",
]);

// ── /models command ──────────────────────────────────────────────────

async function resolveModelList(): Promise<SlashResolution> {
  const config = getConfig();
  const configuredProviders = new Set<string>(await getConfiguredProviders());

  const lines = ["Available models:\n"];

  for (const {
    id: provider,
    displayName: providerName,
    models,
  } of PROVIDER_CATALOG) {
    const hasKey = configuredProviders.has(provider);
    const status = hasKey ? "✓" : "✗";
    lines.push(`**${providerName}** ${status}`);
    for (const { id, displayName } of models) {
      const isCurrent =
        config.llm.default.provider === provider &&
        config.llm.default.model === id;
      const current = isCurrent ? " **[current]**" : "";
      lines.push(`  - ${displayName} (\`${id}\`)${current}`);
    }
    lines.push("");
  }

  lines.push("✓ = API key configured, ✗ = not configured");
  lines.push("\nTip: Configure a provider with `keys set <provider> <key>`");

  return {
    kind: "unknown",
    message: lines.join("\n"),
  };
}

function resolveStatusCommand(context: SlashContext): SlashResolution {
  const {
    inputTokens,
    maxInputTokens,
    model,
    provider,
    messageCount,
    outputTokens,
    estimatedCost,
  } = context;
  const pct =
    maxInputTokens > 0
      ? Math.min(Math.round((inputTokens / maxInputTokens) * 100), 100)
      : 0;
  const filled = Math.round(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const fmt = (n: number) => n.toLocaleString("en-US");

  const lines = [
    "Conversation Status\n",
    `Context:  ${bar}  ${pct}%  (${fmt(inputTokens)} / ${fmt(
      maxInputTokens,
    )} tokens)`,
    `Model:    ${model} (${provider})`,
    `Messages: ${fmt(messageCount)}`,
    `Tokens:   ${fmt(inputTokens)} in / ${fmt(outputTokens)} out`,
    `Cost:     $${estimatedCost.toFixed(2)} (estimated)`,
  ];

  return { kind: "unknown", message: lines.join("\n") };
}

function resolveCommandsList(context?: SlashContext): string[] {
  const fallbackLines = [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    "/models — List all available models",
    "/pair — Generate pairing info for connecting a mobile device",
  ];
  if (context) {
    fallbackLines.push("/status — Show conversation status and context usage");
  }

  if (!context?.userMessageInterface) return fallbackLines;

  if (context.userMessageInterface === "macos") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
      "/pair — Generate pairing info for connecting a mobile device",
    ];
  }

  if (context.userMessageInterface === "ios") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  return [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    "/models — List all available models",
    "/status — Show conversation status and context usage",
    "/btw — Ask a side question while the assistant is working",
  ];
}

/**
 * Pure classifier: returns the kind of slash resolution `resolveSlash` would
 * produce for `content`, without triggering any side effects.
 *
 * Queue-drain lookahead (`buildPassthroughBatch`) uses this to decide whether
 * to include a queued message in a contiguous passthrough batch. `resolveSlash`
 * itself runs side effects (e.g. `/pair` registers a pairing request and
 * writes a QR PNG), so calling it during lookahead and then again in the real
 * drain would execute those side effects twice — the second call sees the
 * first registration and fails with "active pairing already in progress".
 */
export function classifySlash(
  content: string,
): "passthrough" | "compact" | "unknown" {
  const trimmed = content.trim();
  if (
    trimmed === "/model" ||
    (trimmed.startsWith("/model ") && trimmed !== "/models")
  ) {
    return "unknown";
  }
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return "unknown";
  }
  if (trimmed === "/models") return "unknown";
  if (trimmed === "/pair") return "unknown";
  if (trimmed === "/compact") return "compact";
  if (trimmed === "/status") return "unknown";
  if (trimmed === "/commands") return "unknown";
  return "passthrough";
}

/**
 * Resolve built-in slash commands (/models, /status, /commands, /compact, /pair).
 * Returns `unknown` with a deterministic message, `compact` for forced compaction,
 * or the (possibly rewritten) content as `passthrough`.
 */
export async function resolveSlash(
  content: string,
  context?: SlashContext,
): Promise<SlashResolution> {
  // Handle deprecated model-switching commands — direct users to Settings
  const trimmed = content.trim();
  if (
    trimmed === "/model" ||
    (trimmed.startsWith("/model ") && trimmed !== "/models")
  ) {
    return {
      kind: "unknown",
      message:
        "The `/model` command has been removed. Use **Settings → Models & Services** to change your model and provider.",
    };
  }

  // Reject deprecated provider shortcut commands (/opus, /sonnet, /haiku, etc.)
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return {
      kind: "unknown",
      message: `The \`/${shortcutMatch[1]}\` shortcut has been removed. Use **Settings → Models & Services** to change your model and provider.`,
    };
  }

  // Handle /models command (read-only listing)
  if (trimmed === "/models") {
    return await resolveModelList();
  }

  // Handle /pair command
  const pairResult = resolvePairCommand(content, context);
  if (pairResult) return pairResult;

  // Handle /compact command
  if (trimmed === "/compact") {
    return { kind: "compact" };
  }

  // Handle /status command
  if (trimmed === "/status") {
    if (!context) {
      return {
        kind: "unknown",
        message: "Status information is not available in this context.",
      };
    }
    return resolveStatusCommand(context);
  }

  // Handle /commands command
  if (trimmed === "/commands") {
    return {
      kind: "unknown",
      message: resolveCommandsList(context).join("\n"),
    };
  }

  return { kind: "passthrough", content };
}

// ── /pair command ────────────────────────────────────────────────────

function buildPairingQRCodeFilename(): string {
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `code${ts}.png`;
}

async function savePairingQRCodePng(
  payloadJson: string,
  filename: string,
): Promise<void> {
  const qrDir = join(getWorkspaceDir(), "pairing-qr");
  mkdirSync(qrDir, { recursive: true });
  const qrPngPath = join(qrDir, filename);
  const pngBuffer = await QRCode.toBuffer(payloadJson, {
    type: "png",
    width: 512,
  });
  writeFileSync(qrPngPath, pngBuffer);
}

function resolvePairCommand(
  content: string,
  context?: SlashContext,
): SlashResolution | null {
  if (content.trim() !== "/pair") return null;

  if (context?.userMessageInterface && context.userMessageInterface !== "macos") {
    return {
      kind: "unknown",
      message:
        "The `/pair` command is only available in the macOS desktop app.",
    };
  }

  if (!pairingStoreRef) {
    return {
      kind: "unknown",
      message:
        "Pairing is not available — the runtime HTTP server has not started yet.",
    };
  }

  const gatewayUrl = getIngressPublicBaseUrl();
  const lanIp = getLocalIPv4();
  const localLanUrl = lanIp ? `http://${lanIp}:${getGatewayPort()}` : null;

  if (!gatewayUrl && !localLanUrl) {
    return {
      kind: "unknown",
      message:
        "Cannot generate pairing info — no gateway URL is configured and no LAN address was detected.\n\n" +
        "Set a public gateway URL with `config set ingress.publicBaseUrl <url>`.",
    };
  }

  const effectiveGatewayUrl = gatewayUrl || localLanUrl!;

  const pairingRequestId = randomUUID();
  const pairingSecret = randomBytes(32).toString("hex");

  const result = pairingStoreRef.register({
    pairingRequestId,
    pairingSecret,
    gatewayUrl: effectiveGatewayUrl,
    localLanUrl,
  });

  if (!result.ok) {
    const message =
      result.reason === "active_pairing"
        ? "A pairing request is already in progress. Wait for it to complete or expire before running `/pair` again."
        : "Failed to register pairing request (ID conflict). Please try `/pair` again.";
    return { kind: "unknown", message };
  }

  const payload: Record<string, unknown> = {
    type: "vellum-daemon",
    v: 4,
    g: effectiveGatewayUrl,
    pairingRequestId,
    pairingSecret,
  };
  if (localLanUrl) {
    payload.localLanUrl = localLanUrl;
  }

  // Save QR code as PNG to the workspace pairing-qr folder (fire-and-forget
  // so the synchronous slash resolution is not blocked).
  const payloadJson = JSON.stringify(payload);
  const qrFilename = buildPairingQRCodeFilename();
  silentlyWithLog(
    savePairingQRCodePng(payloadJson, qrFilename),
    "save pairing QR code PNG",
  );

  const lines = [
    "Pairing Ready\n",
    "Scan the QR code below with the Vellum iOS app, or use the pairing payload to connect manually.\n",
    "```json",
    JSON.stringify(payload, null, 2),
    "```\n",
    `Gateway:  ${effectiveGatewayUrl}`,
  ];
  if (localLanUrl) {
    lines.push(`LAN URL:  ${localLanUrl}`);
  }
  lines.push(
    `\nQR code saved to pairing-qr/${qrFilename}`,
    "\nThis pairing request expires in 5 minutes. Run `/pair` again to generate a new one.",
  );

  return { kind: "unknown", message: lines.join("\n"), qrFilename };
}

// ── Provider Ordering Error Detection ────────────────────────────────

const ORDERING_ERROR_PATTERNS = [
  /tool_result.*not immediately after.*tool_use/i,
  /tool_use.*must have.*tool_result/i,
  /tool_use_id.*without.*tool_result/i,
  /tool_result.*tool_use_id.*not found/i,
  /messages.*invalid.*order/i,
];

export function isProviderOrderingError(message: string): boolean {
  return ORDERING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
