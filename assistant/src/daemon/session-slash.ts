import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import QRCode from "qrcode";

import { getGatewayPort, getIngressPublicBaseUrl } from "../config/env.js";
import { getConfig, loadRawConfig, saveRawConfig } from "../config/loader.js";
import { resolveSkillStates } from "../config/skill-state.js";
import { loadSkillCatalog } from "../config/skills.js";
import { initializeProviders } from "../providers/registry.js";
import {
  buildInvocableSlashCatalog,
  resolveSlashSkillCommand,
  rewriteKnownSlashCommandPrompt,
} from "../skills/slash-commands.js";
import { getLocalIPv4 } from "../util/network-info.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getAssistantName } from "./identity-helpers.js";
import type { PairingStore } from "./pairing-store.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "rewritten"; content: string; skillId: string }
  | { kind: "unknown"; message: string; qrFilename?: string };

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
}

// ── /model command ───────────────────────────────────────────────────

const AVAILABLE_MODELS = [
  "claude-opus-4-6",
  "claude-opus-4-6-fast",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-6-fast": "Claude Opus 4.6 Fast",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
};

const PROVIDER_MODEL_SHORTCUTS: Record<
  string,
  { provider: string; model: string; displayName: string }
> = {
  // Anthropic
  opus: {
    provider: "anthropic",
    model: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
  },
  "opus-fast": {
    provider: "anthropic",
    model: "claude-opus-4-6-fast",
    displayName: "Claude Opus 4.6 Fast",
  },
  sonnet: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
  },
  haiku: {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
  },

  // OpenAI
  gpt4: { provider: "openai", model: "gpt-4", displayName: "GPT-4" },
  gpt4o: { provider: "openai", model: "gpt-4o", displayName: "GPT-4o" },
  gpt5: { provider: "openai", model: "gpt-5.2", displayName: "GPT-5.2" },

  // Gemini
  gemini: {
    provider: "gemini",
    model: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
  },

  // Ollama
  ollama: { provider: "ollama", model: "llama3.2", displayName: "Llama 3.2" },

  // Fireworks
  fireworks: {
    provider: "fireworks",
    model: "accounts/fireworks/models/kimi-k2p5",
    displayName: "Kimi K2.5",
  },

  // OpenRouter
  openrouter: {
    provider: "openrouter",
    model: "x-ai/grok-4",
    displayName: "Grok 4 (OpenRouter)",
  },
};

/** True when the trimmed content matches a provider shortcut like /opus, /gpt4, etc. */
export function isProviderShortcut(content: string): boolean {
  const match = content.trim().match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (!match) return false;
  return match[1].toLowerCase() in PROVIDER_MODEL_SHORTCUTS;
}

/** Reverse lookup: model ID → provider, derived from PROVIDER_MODEL_SHORTCUTS. */
export const MODEL_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_MODEL_SHORTCUTS).map(({ model, provider }) => [
    model,
    provider,
  ]),
);

/** Partial-match a user input like "opus", "sonnet", "haiku" to a full model ID. */
function matchModel(input: string): string | undefined {
  const lower = input.toLowerCase().trim();
  // Exact match first
  const exact = AVAILABLE_MODELS.find((m) => m === lower);
  if (exact) return exact;
  // Partial match (e.g. "opus" → "claude-opus-4-6")
  return AVAILABLE_MODELS.find((m) => m.includes(lower));
}

function resolveProviderModelCommand(content: string): SlashResolution | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;

  // Extract the command (e.g., "/gpt4" → "gpt4")
  const match = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const shortcut = PROVIDER_MODEL_SHORTCUTS[command];
  if (!shortcut) return null;

  const { provider, model, displayName } = shortcut;
  const config = getConfig();
  const name = getAssistantName();

  // Check if API key exists for this provider (Ollama doesn't require an API key)
  if (provider !== "ollama" && !config.apiKeys[provider]) {
    return {
      kind: "unknown",
      message: `Cannot switch to ${displayName}. No API key configured for ${provider}.\n\nSet it with: \`keys set ${provider} <your-key>\``,
    };
  }

  // Check if already using this provider+model
  if (config.provider === provider && config.model === model) {
    const alreadyMsg = name
      ? `${name} is already running on **${displayName}**.`
      : `Already using **${displayName}**.`;
    return {
      kind: "unknown",
      message: alreadyMsg,
    };
  }

  // Update config with both provider and model
  const raw = loadRawConfig();
  raw.provider = provider;
  raw.model = model;
  saveRawConfig(raw);

  // Re-initialize providers with new config
  const newConfig = getConfig();
  initializeProviders(newConfig);

  const switchedMsg = name
    ? `Switched ${name} to **${displayName}**. New conversations will use this model.`
    : `Switched to **${displayName}**. New conversations will use this model.`;

  return {
    kind: "unknown",
    message: switchedMsg,
  };
}

function resolveModelList(): SlashResolution {
  const config = getConfig();
  const lines = ["Available models:\n"];

  for (const [cmd, { provider, model, displayName }] of Object.entries(
    PROVIDER_MODEL_SHORTCUTS,
  )) {
    const hasKey = provider === "ollama" || !!config.apiKeys[provider];
    const isCurrent = config.provider === provider && config.model === model;
    const status = hasKey ? "✓" : "✗";
    const current = isCurrent ? " **[current]**" : "";
    lines.push(`- **${displayName}** (/${cmd}) ${status}${current}`);
  }

  lines.push("\n✓ = API key configured, ✗ = not configured");
  lines.push("\nTip: Configure a provider with `keys set <provider> <key>`");

  return {
    kind: "unknown",
    message: lines.join("\n"),
  };
}

function resolveModelCommand(content: string): SlashResolution | null {
  const trimmed = content.trim();
  // Match /models → route to list
  if (trimmed === "/models") {
    return resolveModelList();
  }

  if (!trimmed.startsWith("/model")) return null;
  // Ensure it's exactly "/model" or "/model " (not "/modelsomething")
  if (trimmed.length > 6 && trimmed[6] !== " ") return null;

  const args = trimmed.slice(6).trim();
  const name = getAssistantName();

  if (!args) {
    // Show current model
    const config = getConfig();
    const displayName = MODEL_DISPLAY_NAMES[config.model] ?? config.model;
    const prefix = name ? `${name} is running on` : `Currently using`;
    return {
      kind: "unknown",
      message: `${prefix} **${displayName}** (\`${config.model}\`).`,
    };
  }

  // Handle /model list
  if (args === "list") {
    return resolveModelList();
  }

  // Try to match the model name
  const matched = matchModel(args);
  if (!matched) {
    const available = AVAILABLE_MODELS.map(
      (m) => `- **${MODEL_DISPLAY_NAMES[m]}** (\`${m}\`)`,
    ).join("\n");
    return {
      kind: "unknown",
      message: `Hmm, "${args}" doesn't match any available model. Here's what you can pick from:\n${available}`,
    };
  }

  // Check if already using this model
  const currentConfig = getConfig();
  if (currentConfig.model === matched) {
    const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;
    const alreadyMsg = name
      ? `${name} is already running on **${displayName}**.`
      : `Already on **${displayName}**.`;
    return {
      kind: "unknown",
      message: alreadyMsg,
    };
  }

  // Validate that Anthropic provider is available
  if (!currentConfig.apiKeys.anthropic) {
    const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;
    return {
      kind: "unknown",
      message: `Cannot switch to ${displayName}. No API key configured for Anthropic.\n\nSet it with: \`keys set anthropic <your-key>\``,
    };
  }

  // Change model: save config and re-initialize providers
  const raw = loadRawConfig();
  raw.provider = "anthropic"; // Ensure provider is set for Anthropic models
  raw.model = matched;
  saveRawConfig(raw);
  const config = getConfig();
  initializeProviders(config);

  const displayName = MODEL_DISPLAY_NAMES[matched] ?? matched;
  const switchedMsg = name
    ? `Switched ${name} to **${displayName}**. New conversations will use this model.`
    : `Switched to **${displayName}**. New conversations will use this model.`;
  return {
    kind: "unknown",
    message: switchedMsg,
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
  const displayName = MODEL_DISPLAY_NAMES[model] ?? model;

  const lines = [
    "Session Status\n",
    `Context:  ${bar}  ${pct}%  (${fmt(inputTokens)} / ${fmt(
      maxInputTokens,
    )} tokens)`,
    `Model:    ${displayName} (${provider})`,
    `Messages: ${fmt(messageCount)}`,
    `Tokens:   ${fmt(inputTokens)} in / ${fmt(outputTokens)} out`,
    `Cost:     $${estimatedCost.toFixed(2)} (estimated)`,
  ];

  return { kind: "unknown", message: lines.join("\n") };
}

/**
 * Resolve slash commands against the current skill catalog.
 * Returns `unknown` with a deterministic message, or the (possibly rewritten) content.
 */
export function resolveSlash(
  content: string,
  context?: SlashContext,
): SlashResolution {
  // Check provider shortcuts first (/gpt4, /opus, etc.)
  const providerResult = resolveProviderModelCommand(content);
  if (providerResult) return providerResult;

  // Handle /model command
  const modelResult = resolveModelCommand(content);
  if (modelResult) return modelResult;

  // Handle /pair command
  const pairResult = resolvePairCommand(content);
  if (pairResult) return pairResult;

  // Handle /status command
  if (content.trim() === "/status") {
    if (!context) {
      return {
        kind: "unknown",
        message: "Status information is not available in this context.",
      };
    }
    return resolveStatusCommand(context);
  }

  // Handle /commands command
  if (content.trim() === "/commands") {
    const lines = [
      "/commands — List all available commands",
      "/model — Show or switch the current model",
      "/models — List all available models",
      "/pair — Generate pairing info for connecting a mobile device",
    ];
    if (context) {
      lines.push("/status — Show session status and context usage");
    }
    return {
      kind: "unknown",
      message: lines.join("\n"),
    };
  }

  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);
  const invocable = buildInvocableSlashCatalog(catalog, resolved);
  const resolution = resolveSlashSkillCommand(content, invocable);

  if (resolution.kind === "known") {
    const skill = invocable.get(resolution.skillId.toLowerCase());
    return {
      kind: "rewritten",
      content: rewriteKnownSlashCommandPrompt({
        rawInput: content,
        skillId: resolution.skillId,
        skillName: skill?.name ?? resolution.skillId,
        trailingArgs: resolution.trailingArgs,
      }),
      skillId: resolution.skillId,
    };
  }

  if (resolution.kind === "unknown") {
    return { kind: "unknown", message: resolution.message };
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

function resolvePairCommand(content: string): SlashResolution | null {
  if (content.trim() !== "/pair") return null;

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
  savePairingQRCodePng(payloadJson, qrFilename).catch(() => {});

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
