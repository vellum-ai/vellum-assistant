/**
 * Runtime message-injection helpers extracted from Conversation.
 *
 * These functions modify the user-message tail of the conversation
 * before it is sent to the provider.  They are pure (no side effects).
 */

import { statSync } from "node:fs";
import { join } from "node:path";

import { type ChannelId, parseInterfaceId } from "../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite, LLMConfig } from "../config/schemas/llm.js";
import {
  NOW_SCRATCHPAD_STRIP_PREFIXES,
  stripSpotlightInjections,
  stripUserTextBlocksByPrefix,
} from "../context/strip-injections.js";
import { getDocumentsForConversation } from "../documents/document-store.js";
import {
  getApp,
  getAppDirPath,
  listAppFiles,
  resolveAppDir,
} from "../memory/app-store.js";
import {
  getMessages as defaultGetMessages,
  type MessageRow,
} from "../memory/conversation-crud.js";
import { isBackgroundConversationType } from "../memory/conversation-types.js";
import {
  countMemoryPrefixBlocks,
  extractMemoryPrefixBlocks,
  getLiveGraphMemory,
} from "../memory/graph/conversation-graph-memory.js";
import { unwrapMemoryBlock, wrapMemoryBlock } from "../memory/memory-marker.js";
import {
  readSlackMetadata,
  readSlackMetadataFromMessageMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import {
  compareSlackTs,
  extractTagLineTexts,
  isSlackTsAfter,
  type RenderableSlackMessage,
  type RenderedSlackTranscriptMessage,
  renderSlackTranscriptWithProvenance,
} from "../messaging/providers/slack/render-transcript.js";
import { createContextSummaryMessage } from "../plugins/defaults/compaction/window-manager.js";
import { getInjectorChain } from "../plugins/defaults/memory-retrieval/injector-chain.js";
import {
  MEMORY_V3_BLOCK_ID,
  MEMORY_V3_COMMIT_META_KEY,
} from "../plugins/defaults/memory-v3-shadow/types.js";
import type {
  InjectionBlock,
  InjectionPlacement,
  TurnContext,
} from "../plugins/types.js";
import type { ContentBlock, Message } from "../providers/types.js";
import {
  type ActorTrustContext,
  isUntrustedTrustClass,
  resolveActorTrust,
  type TrustClass,
} from "../runtime/actor-trust-resolver.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import { channelStatusToMemberStatus } from "../runtime/routes/inbound-stages/acl-enforcement.js";
import { getSubagentManager } from "../subagent/index.js";
import type { SubagentState } from "../subagent/types.js";
import { TERMINAL_STATUSES } from "../subagent/types.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import { canonicalizeTimeZone, formatTurnTimestamp } from "./date-context.js";
import type {
  DynamicPageSurfaceData,
  SurfaceData,
  SurfaceType,
} from "./message-protocol.js";
import { filterMessagesForUntrustedActor } from "./message-provenance.js";
import type { TrustContext } from "./trust-context.js";

// The compaction strip lives in the compaction layer (`context/`) so the agent
// loop can own it; re-exported here for this module's existing consumers.
export { stripInjectionsForCompaction } from "../context/strip-injections.js";

/**
 * Describes the capabilities of the channel through which the user is
 * interacting.  Used to gate UI-specific references and permission asks.
 */
export interface ChannelCapabilities {
  /** The raw channel identifier (e.g. "vellum", "telegram"). */
  channel: string;
  /** Whether this channel can render the dashboard UI (apps, dynamic pages). */
  dashboardCapable: boolean;
  /** Whether the channel supports dynamic UI surfaces (ui_show / ui_update). */
  supportsDynamicUi: boolean;
  /** Whether the channel supports voice/microphone input. */
  supportsVoiceInput: boolean;
  /** The client OS/interface identifier (e.g. "macos", "ios", "web"). */
  clientOS?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup", "channel", "im", "mpim"). */
  chatType?: string;
}

/**
 * Inbound actor context for the `<turn_context>` block.
 *
 * Carries channel-agnostic identity and trust metadata resolved from
 * inbound message identity fields. This replaces the old `<guardian_context>`
 * block with richer trusted-contact-aware fields.
 */
export interface InboundActorContext {
  /** Source channel the message arrived on. */
  sourceChannel: ChannelId;
  /** Canonical (normalized) sender identity. Null when identity could not be established. */
  canonicalActorIdentity: string | null;
  /** Human-readable actor identifier (e.g. @username or phone). */
  actorIdentifier?: string;
  /** Human-readable actor display name (e.g. "Jeff"). */
  actorDisplayName?: string;
  /** Raw sender display name as provided by the channel transport. */
  actorSenderDisplayName?: string;
  /** Guardian-managed display name from the contact record. */
  actorMemberDisplayName?: string;
  /** Trust classification: guardian, trusted_contact, or unknown. */
  trustClass: "guardian" | "trusted_contact" | "unknown";
  /** Guardian identity for this (assistant, channel) binding. */
  guardianIdentity?: string;
  /** Member status when the actor has a contact record. */
  memberStatus?: string;
  /** Member policy when the actor has a contact record. */
  memberPolicy?: string;
  /** Free-text notes about this contact. */
  contactNotes?: string;
  /** Number of prior interactions with this contact. */
  contactInteractionCount?: number;
}

/**
 * Construct an InboundActorContext from a TrustContext.
 *
 * Maps the runtime trust class into the model-facing inbound actor context.
 */
export function inboundActorContextFromTrustContext(
  ctx: TrustContext,
): InboundActorContext {
  return {
    sourceChannel: ctx.sourceChannel,
    canonicalActorIdentity: ctx.requesterExternalUserId ?? null,
    actorIdentifier: ctx.requesterIdentifier,
    actorDisplayName: ctx.requesterDisplayName,
    actorSenderDisplayName: ctx.requesterSenderDisplayName,
    actorMemberDisplayName: ctx.requesterMemberDisplayName,
    trustClass: ctx.trustClass,
    guardianIdentity: ctx.guardianExternalUserId,
  };
}

/**
 * Construct an InboundActorContext from an ActorTrustContext (the new
 * unified trust resolver output from M1).
 */
export function inboundActorContextFromTrust(
  ctx: ActorTrustContext,
): InboundActorContext {
  return {
    sourceChannel: ctx.actorMetadata.channel,
    canonicalActorIdentity: ctx.canonicalSenderId,
    actorIdentifier: ctx.actorMetadata.identifier,
    actorDisplayName: ctx.actorMetadata.displayName,
    actorSenderDisplayName: ctx.actorMetadata.senderDisplayName,
    actorMemberDisplayName: ctx.actorMetadata.memberDisplayName,
    trustClass: ctx.trustClass,
    guardianIdentity: ctx.guardianBindingMatch?.guardianExternalUserId,
    memberStatus: ctx.memberRecord
      ? channelStatusToMemberStatus(ctx.memberRecord.channel.status)
      : undefined,
    memberPolicy: ctx.memberRecord?.channel.policy ?? undefined,
    contactNotes: ctx.memberRecord?.contact.notes ?? undefined,
    contactInteractionCount:
      ctx.memberRecord?.contact.interactionCount ?? undefined,
  };
}

/**
 * Resolve the model-facing inbound actor context for a turn from the
 * conversation's trust context, for the unified `<turn_context>` actor section.
 *
 * Returns `null` when there is no trust context and on guardian (owner) turns —
 * the actor section is suppressed for the owner. When the trust context carries
 * enough identity to look up member status / policy and the guardian binding,
 * the unified actor-trust resolver is preferred; otherwise the context is
 * projected directly. Derives purely from the passed trust context, so callers
 * self-resolve it from the live conversation rather than threading it.
 */
export function resolveTurnInboundActorContext(
  trustContext: TrustContext | undefined,
  assistantId: string | undefined,
): InboundActorContext | null {
  if (!trustContext) {
    return null;
  }
  let resolved: InboundActorContext;
  if (trustContext.requesterExternalUserId && trustContext.requesterChatId) {
    const actorTrust = resolveActorTrust({
      assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
      sourceChannel: trustContext.sourceChannel,
      conversationExternalId: trustContext.requesterChatId,
      actorExternalId: trustContext.requesterExternalUserId,
      actorDisplayName: trustContext.requesterSenderDisplayName,
    });
    resolved = inboundActorContextFromTrust(actorTrust);
  } else {
    resolved = inboundActorContextFromTrustContext(trustContext);
  }
  return resolved.trustClass === "guardian" ? null : resolved;
}

/**
 * Render the `model_profile:` turn-context label for a turn from its resolved
 * inference profile key, for the unified `<turn_context>` block.
 *
 * Returns `null` when there is no key to announce (the caller gates this to the
 * turns where the active profile changed since the one last delivered to the
 * model). Otherwise the human-readable label comes from the profile's
 * configured `label` (falling back to the key) and the model id from the
 * call-site resolution keyed on that profile, yielding `Label (model)` — or
 * just `Label` when no model resolves. Derives purely from the passed key,
 * call site, and config, so callers thread the key (plain turn data) rather
 * than the rendered string and self-resolve the call site from the live
 * conversation.
 *
 * `selectionSeed` is the conversation id, threaded so that a key naming a `mix`
 * profile expands to the same arm the turn's provider calls run on (which seed
 * expansion with the same id). Without it the announced model would be a fresh
 * random arm that can disagree with the model actually serving the turn.
 */
export function resolveTurnModelProfileLabel(
  modelProfileKey: string | null,
  callSite: LLMCallSite,
  llm: LLMConfig,
  selectionSeed?: string,
): string | null {
  if (modelProfileKey == null) {
    return null;
  }
  const profileEntry = llm.profiles?.[modelProfileKey];
  const resolved = resolveCallSiteConfig(callSite, llm, {
    overrideProfile: modelProfileKey,
    selectionSeed,
  });
  const label = profileEntry?.label ?? modelProfileKey;
  return resolved.model ? `${label} (${resolved.model})` : label;
}

/** Derive channel capabilities from source channel + interface identifiers. */
export function resolveChannelCapabilities(
  sourceChannel?: string | null,
  sourceInterface?: string | null,
  chatType?: string | null,
): ChannelCapabilities {
  // Normalise legacy pseudo-channel IDs to canonical ChannelId values.
  let channel: string;
  switch (sourceChannel) {
    case null:
    case undefined:
    case "dashboard":
    case "http-api":
    case "mac":
    case "macos":
    case "ios":
      channel = "vellum";
      break;
    default:
      channel = sourceChannel;
  }

  let iface = parseInterfaceId(sourceInterface);
  if (!iface) {
    switch (sourceInterface) {
      case "mac":
        iface = "macos";
        break;
      case "desktop":
      case "http-api":
      case "dashboard":
        iface = "web";
        break;
      default:
        iface = null;
        break;
    }
  }

  const resolvedChatType = chatType ?? undefined;

  switch (channel) {
    case "vellum": {
      const supportsDesktopUi = iface === "macos";
      return {
        channel,
        dashboardCapable: supportsDesktopUi,
        supportsDynamicUi: supportsDesktopUi || iface === "web",
        supportsVoiceInput: supportsDesktopUi,
        clientOS: iface ?? undefined,
        chatType: resolvedChatType,
      };
    }
    case "telegram":
    case "phone":
    case "whatsapp":
    case "slack":
    case "email":
      return {
        channel,
        dashboardCapable: false,
        supportsDynamicUi: false,
        supportsVoiceInput: false,
        chatType: resolvedChatType,
      };
    default:
      return {
        channel,
        dashboardCapable: false,
        supportsDynamicUi: false,
        supportsVoiceInput: false,
        chatType: resolvedChatType,
      };
  }
}

/**
 * Returns true when the chat type indicates a group/multi-party conversation
 * (Telegram group/supergroup, Slack channel/group/mpim, etc.).
 *
 * Slack "channel" is intentionally classified as group chat: channels are
 * inherently multi-party spaces where group etiquette (e.g. only respond when
 * addressed) applies — even for low-traffic or announcement-style channels.
 * The etiquette helps the assistant avoid responding to every message in a
 * channel where it is a passive participant.
 */
export function isGroupChatType(chatType?: string): boolean {
  if (!chatType) return false;
  switch (chatType) {
    case "group": // Telegram group
    case "supergroup": // Telegram supergroup
    case "channel": // Slack channel — multi-party by definition
    case "mpim": // Slack multi-party direct message
      return true;
    default:
      return false;
  }
}

/** Context about the active workspace surface, rendered into the `<active_workspace>` block. */
interface ActiveSurfaceContext {
  surfaceId: string;
  html: string;
  /** When set, the surface is backed by a persisted app. */
  appId?: string;
  appName?: string;
  /** Filesystem directory/slug for the app (used to construct file paths). */
  appDirName?: string;
  appSchemaJson?: string;
  /** Additional pages keyed by filename (e.g. "settings.html" → HTML content). */
  appPages?: Record<string, string>;
  /** The page currently displayed in the WebView (e.g. "settings.html"). */
  currentPage?: string;
}

/**
 * Resolve the conversation's active workspace surface into the context block
 * consumed by {@link applyRuntimeInjections}, or `null` when no dynamic-page
 * surface is active. App-backed surfaces are enriched with their persisted app
 * metadata; the file tree is listed on demand by the injector.
 */
export function buildActiveSurfaceContext(params: {
  currentActiveSurfaceId: string | undefined;
  currentPage: string | undefined;
  surfaceState: ReadonlyMap<
    string,
    { surfaceType: SurfaceType; data: SurfaceData }
  >;
}): ActiveSurfaceContext | null {
  const { currentActiveSurfaceId, currentPage, surfaceState } = params;
  if (!currentActiveSurfaceId) return null;

  const stored = surfaceState.get(currentActiveSurfaceId);
  if (!stored || stored.surfaceType !== "dynamic_page") return null;

  const data = stored.data as DynamicPageSurfaceData;
  const activeSurface: ActiveSurfaceContext = {
    surfaceId: currentActiveSurfaceId,
    html: data.html,
    currentPage,
  };

  if (data.appId) {
    const app = getApp(data.appId);
    if (app) {
      activeSurface.appId = app.id;
      activeSurface.appName = app.name;
      activeSurface.appDirName = resolveAppDir(app.id).dirName;
      activeSurface.appSchemaJson = app.schemaJson;
      if (app.pages && Object.keys(app.pages).length > 0) {
        activeSurface.appPages = app.pages;
      }
    }
  }

  return activeSurface;
}

/**
 * Lists the conversation's active documents as the lightweight summaries the
 * `active-documents` injector surfaces to the assistant — letting it target
 * existing documents with `document_update` instead of issuing duplicate
 * `document_create` calls. Returns `null` when the conversation has none.
 */
export function buildActiveDocuments(conversationId: string): Array<{
  surfaceId: string;
  title: string;
  wordCount: number;
  updatedAt: number;
}> | null {
  const conversationDocs = getDocumentsForConversation(conversationId);
  return conversationDocs.length > 0
    ? conversationDocs.map((d) => ({
        surfaceId: d.surfaceId,
        title: d.title,
        wordCount: d.wordCount,
        updatedAt: d.updatedAt,
      }))
    : null;
}

const MAX_CONTEXT_LENGTH = 100_000;

function truncateHtml(html: string, budget: number): string {
  if (html.length <= budget) return html;
  return (
    html.slice(0, budget) +
    `\n<!-- truncated: original is ${html.length} characters -->`
  );
}

/**
 * Prepend workspace context so the model can refine UI surfaces.
 * Adapts the injected rules based on whether the surface is app-backed.
 */
function injectActiveSurfaceContext(
  message: Message,
  ctx: ActiveSurfaceContext,
): Message {
  const lines: string[] = ["<active_workspace>"];

  if (ctx.appId) {
    // ── App-backed surface ──
    const slug = ctx.appDirName ?? ctx.appId;
    lines.push(
      `The user is viewing app "${ctx.appName ?? "Untitled"}" (app_id: "${ctx.appId}", slug: "${slug}") in workspace mode.`,
      "",
      'PREREQUISITE: If `app_refresh` is not yet available, call `skill_load` with `skill: "app-builder"` first to load it.',
      "",
      "RULES FOR WORKSPACE MODIFICATION:",
      `1. Use \`file_edit\` to make surgical changes to app files. The file path is \`${getAppDirPath(ctx.appId)}/<path>\`.`,
      "2. Use `file_write` to create new files or rewrite files.",
      "3. Use `file_read` to read any file with line numbers before editing.",
      "4. Use `bash ls` to see all files in the app directory.",
      `5. Call \`app_refresh\` with app_id "${ctx.appId}" ONCE after all changes are complete.`,
      "6. NEVER respond with only text — the user expects a visual update.",
      "7. Make ONLY the changes the user requested. Preserve existing content/styling.",
      "8. Keep your text response to 1 brief sentence confirming what you changed.",
    );

    // File tree with sizes (capped at 50 files to bound prompt size)
    const files = listAppFiles(ctx.appId);
    const MAX_FILE_TREE_ENTRIES = 50;
    const displayFiles = files.slice(0, MAX_FILE_TREE_ENTRIES);
    lines.push("", "App files:");
    for (const filePath of displayFiles) {
      let sizeLabel: string;
      try {
        const bytes = statSync(join(getAppDirPath(ctx.appId), filePath)).size;
        sizeLabel =
          bytes < 1000 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
      } catch {
        sizeLabel = "? KB";
      }
      lines.push(`  ${filePath} (${sizeLabel})`);
    }
    if (files.length > MAX_FILE_TREE_ENTRIES) {
      lines.push(
        `  ... and ${files.length - MAX_FILE_TREE_ENTRIES} more files`,
      );
    }

    // Schema metadata
    const schema = ctx.appSchemaJson;
    const MAX_SCHEMA_LENGTH = 10_000;
    if (schema && schema !== '"{}"' && schema !== "{}") {
      const truncatedSchema =
        schema.length > MAX_SCHEMA_LENGTH
          ? schema.slice(0, MAX_SCHEMA_LENGTH) + "… (truncated)"
          : schema;
      lines.push("", `Data schema: ${truncatedSchema}`);
    }

    // Determine which file content to show based on the currently viewed page
    const viewingPage =
      ctx.currentPage && ctx.currentPage !== "index.html"
        ? ctx.currentPage
        : null;
    let primaryLabel = "index.html";
    let primaryContent = ctx.html;
    if (viewingPage && ctx.appPages?.[viewingPage]) {
      primaryLabel = viewingPage;
      primaryContent = ctx.appPages[viewingPage];
    }

    // Line-numbered current file content
    const schemaSize = schema ? Math.min(schema.length, MAX_SCHEMA_LENGTH) : 0;
    // Reduce budget by 15% to account for line-number prefix overhead (~7 chars/line)
    let mainBudget = Math.floor((MAX_CONTEXT_LENGTH - schemaSize) * 0.85);
    const additionalPageBlocks: string[] = [];

    // Build additional page content (all pages except the primary one)
    const otherPages: Record<string, string> = {};
    if (viewingPage && primaryLabel !== "index.html") {
      otherPages["index.html"] = ctx.html;
    }
    if (ctx.appPages) {
      for (const [filename, content] of Object.entries(ctx.appPages)) {
        if (filename !== primaryLabel) {
          otherPages[filename] = content;
        }
      }
    }

    if (Object.keys(otherPages).length > 0) {
      let additionalSize = 0;
      for (const [filename, content] of Object.entries(otherPages)) {
        additionalSize += filename.length + content.length + 30;
        additionalPageBlocks.push(`--- ${filename} ---`, content);
      }
      if (
        additionalSize + primaryContent.length >
        MAX_CONTEXT_LENGTH - schemaSize
      ) {
        additionalPageBlocks.length = 0;
      } else {
        mainBudget = Math.floor(
          (MAX_CONTEXT_LENGTH - schemaSize - additionalSize) * 0.85,
        );
      }
    }

    // Format file content with line numbers (cat -n style)
    const truncatedContent = truncateHtml(primaryContent, mainBudget);
    const numberedLines = truncatedContent
      .split("\n")
      .map((line, i) => {
        const num = String(i + 1);
        return `${num.padStart(6)}\t${line}`;
      })
      .join("\n");
    lines.push("", `--- ${primaryLabel} ---`, numberedLines);

    if (additionalPageBlocks.length > 0) {
      lines.push("", "Additional page content:", ...additionalPageBlocks);
    }
  } else {
    // ── Ephemeral surface (created via ui_show, no persisted app) ──
    lines.push(
      `The user is viewing a dynamic page (surface_id: "${ctx.surfaceId}") in workspace mode.`,
      "",
      "RULES FOR WORKSPACE MODIFICATION:",
      `1. You MUST call \`ui_update\` with surface_id "${ctx.surfaceId}" and data.html containing`,
      "   the complete updated HTML.",
      "   NEVER respond with only text — the user expects a visual update every time they",
      "   send a message here. Even if the page appears to already show what they want,",
      "   call ui_update anyway (the user sees a broken experience when no update arrives).",
      "2. You MAY call other tools first to gather data before calling ui_update.",
      "3. Do NOT call ui_show — modify the existing page.",
      "4. Make ONLY the changes the user requested. Preserve all existing content,",
      "   styling, and functionality unless explicitly asked to change them.",
      "5. Keep your text response to 1 brief sentence confirming what you changed.",
      "",
      "Current HTML:",
      truncateHtml(ctx.html, MAX_CONTEXT_LENGTH),
    );
  }

  lines.push("</active_workspace>");

  const block = lines.join("\n");
  return {
    ...message,
    content: [{ type: "text", text: block }, ...message.content],
  };
}

// ---------------------------------------------------------------------------
// Subagent status injection
// ---------------------------------------------------------------------------

/** Escape XML special characters to prevent injection in XML blocks. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the `<active_subagents>` injection block from the current child states.
 * Returns null if there are no children (zero overhead for non-subagent parents).
 */
export function buildSubagentStatusBlock(
  children: SubagentState[],
): string | null {
  if (children.length === 0) return null;

  const now = Date.now();
  const lines: string[] = ["<active_subagents>"];
  for (const child of children) {
    const elapsed = child.startedAt
      ? `${Math.round((now - child.startedAt) / 1000)}s`
      : "pending";
    const parts = [
      `- [${child.status}] "${escapeXml(child.config.label)}" (${escapeXml(child.config.id)})`,
    ];
    if (!TERMINAL_STATUSES.has(child.status)) {
      parts.push(`elapsed: ${elapsed}`);
    }
    if (child.status === "failed" && child.error) {
      parts.push(`error: ${escapeXml(child.error)}`);
    }
    lines.push(parts.join(" | "));
  }
  lines.push(
    "",
    "Use subagent_read to retrieve output from completed/failed subagents.",
    "</active_subagents>",
  );
  return lines.join("\n");
}

// The `<active_subagents>` block is emitted by the `subagent-status` default
// injector (`plugins/defaults/memory-retrieval/injectors.ts`) as an `append-user-tail`
// placement. `applyRuntimeInjections` resolves the block from the live
// subagent manager keyed by the conversation, so callers do not pass it in.

/**
 * Append voice call-control protocol instructions to the last user
 * message so the model knows how to emit control markers during voice
 * turns routed through the conversation pipeline.
 */
function injectVoiceCallControlContext(
  message: Message,
  prompt: string,
): Message {
  return {
    ...message,
    content: [...message.content, { type: "text", text: prompt }],
  };
}

// ---------------------------------------------------------------------------
// NOW.md scratchpad injection
// ---------------------------------------------------------------------------

/** Strip `<NOW.md>` blocks injected by the `now-md` default injector. */
export function stripNowScratchpad(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, NOW_SCRATCHPAD_STRIP_PREFIXES);
}

/**
 * Prepend channel capability context to the last user message so the
 * model knows what the current channel can and cannot do.
 */
export function injectChannelCapabilityContext(
  message: Message,
  caps: ChannelCapabilities,
): Message {
  // Happy path: desktop with full capabilities and no special context — skip injection.
  if (
    caps.dashboardCapable &&
    caps.supportsDynamicUi &&
    caps.supportsVoiceInput &&
    !isGroupChatType(caps.chatType) &&
    caps.clientOS !== "macos"
  ) {
    return message;
  }

  const lines: string[] = ["<channel_capabilities>"];
  lines.push(`channel: ${caps.channel}`);
  lines.push(`dashboard_capable: ${caps.dashboardCapable}`);
  lines.push(`supports_dynamic_ui: ${caps.supportsDynamicUi}`);
  lines.push(`supports_voice_input: ${caps.supportsVoiceInput}`);
  if (caps.clientOS) {
    lines.push(`client_os: ${caps.clientOS}`);
  }

  if (caps.clientOS === "macos") {
    lines.push("");
    lines.push(
      "On macOS, prefer osascript/CLI via `host_bash` over computer use tools, which take over the user's cursor. Use foreground computer use only when no scripting alternative exists or the user explicitly asks.",
    );
  }

  if (!caps.dashboardCapable) {
    lines.push("");
    lines.push("CHANNEL CONSTRAINTS:");
    lines.push(
      "- Do NOT reference the dashboard UI, settings panels, or visual preference pickers.",
    );
    if (!caps.supportsDynamicUi) {
      if (caps.channel === "slack") {
        lines.push(
          '- Do NOT use app_create. Only use ui_show/ui_update for card surfaces with template: "task_progress"; present all other information as text.',
        );
      } else {
        lines.push(
          "- Do NOT use ui_show, ui_update, or app_create — this channel cannot render them.",
        );
      }
      lines.push(
        "- Present information as well-formatted text instead of dynamic UI.",
      );
    }
    if (caps.channel === "whatsapp") {
      lines.push(
        "- Do NOT use markdown tables — use bullet lists instead. No markdown headers — use **bold** or CAPS for emphasis.",
      );
    }
  }

  // Inject group chat etiquette only when the chat type indicates a multi-party
  // conversation, avoiding misconditioned "stay silent" guidance in 1:1 DMs.
  if (isGroupChatType(caps.chatType)) {
    lines.push(`chat_type: ${caps.chatType}`);
    lines.push("");
    lines.push("GROUP CHAT ETIQUETTE:");
    lines.push(
      "- You are a **participant**, not the user's proxy. Think before you speak.",
    );
    lines.push(
      "- **Respond when:** directly mentioned, you can add genuine value, something witty fits naturally, or correcting important misinformation.",
    );
    lines.push(
      '- **Stay silent when:** casual banter between humans, someone already answered, your response would just be "yeah" or "nice", or the conversation flows fine without you.',
    );
    lines.push(
      "- **The human rule:** humans don't respond to every message in a group chat. Neither should you. Quality over quantity.",
    );
    if (caps.channel === "slack") {
      lines.push(
        "- Use emoji reactions naturally to acknowledge without cluttering.",
      );
    }
  }

  lines.push("</channel_capabilities>");

  const block = lines.join("\n");
  return {
    ...message,
    content: [{ type: "text", text: block }, ...message.content],
  };
}

/** Channel command intent metadata (e.g. Telegram /start). */
export interface ChannelCommandContext {
  type: string;
  payload?: string;
  languageCode?: string;
}

/**
 * Prepend channel command context to the last user message so the
 * model knows this turn was triggered by a channel command (e.g. /start).
 */
export function injectChannelCommandContext(
  message: Message,
  ctx: ChannelCommandContext,
): Message {
  const lines: string[] = ["<channel_command_context>"];
  lines.push(`command_type: ${ctx.type}`);
  if (ctx.payload) {
    lines.push(`payload: ${ctx.payload}`);
  }
  if (ctx.languageCode) {
    lines.push(`language_code: ${ctx.languageCode}`);
  }

  if (ctx.type === "start") {
    lines.push(
      "Respond with a warm, brief greeting (1-3 sentences). Treat /start as a hello. Do NOT reset conversation or mention slash commands. If a payload is present, acknowledge it warmly. Respond in the user's language if available from context, otherwise default to English.",
    );
  }

  lines.push("</channel_command_context>");

  const block = lines.join("\n");
  return {
    ...message,
    content: [{ type: "text", text: block }, ...message.content],
  };
}

// ---------------------------------------------------------------------------
// Individual strip functions (thin wrappers around the primitive)
// ---------------------------------------------------------------------------

/** Strip `<channel_capabilities>` blocks injected by `injectChannelCapabilityContext`. */
export function stripChannelCapabilityContext(messages: Message[]): Message[] {
  return stripUserTextBlocksByPrefix(messages, ["<channel_capabilities>"]);
}

// ---------------------------------------------------------------------------
// Transport hints injection (e.g. Slack thread context from the gateway)
// ---------------------------------------------------------------------------

function injectTransportHints(message: Message, hints: string[]): Message {
  const block = `<transport_hints>\n${hints.join("\n")}\n</transport_hints>`;
  return {
    ...message,
    content: [{ type: "text", text: block }, ...message.content],
  };
}

// ---------------------------------------------------------------------------
// Slack chronological transcript assembly
// ---------------------------------------------------------------------------

/**
 * True when the channel capabilities describe a Slack non-DM conversation
 * (group/channel/mpim). Used to gate thread-only behavior such as the
 * `<active_thread>` focus block. DMs are excluded because they have no
 * threads.
 *
 * The gateway normalizer sets `chatType: "channel"` for every non-DM Slack
 * conversation (public, private, and mpim alike — see
 * `gateway/src/slack/normalize.ts`) and omits the field entirely for DMs.
 * We therefore accept only `chatType === "channel"` — when the gateway
 * omits `chatType` (as it does for DMs), the check correctly returns
 * `false`.
 *
 * The chronological-transcript override applies to ALL Slack
 * conversations (channels and DMs) — gate that on
 * `channelCapabilities.channel === "slack"` rather than this helper.
 */
export function isSlackChannelConversation(
  channelCapabilities?: ChannelCapabilities | null,
): boolean {
  return (
    channelCapabilities?.channel === "slack" &&
    channelCapabilities.chatType === "channel"
  );
}

/**
 * Minimal structural shape of a persisted message row used by the Slack
 * chronological-transcript assembly path. Decouples the assembly logic from
 * the DB-row type so it can be unit-tested with plain literals.
 */
export interface SlackTranscriptInputRow {
  role: "user" | "assistant";
  /** Raw persisted content column. JSON-encoded `ContentBlock[]` in production. */
  content: string;
  /** Epoch ms when the row was created. */
  createdAt: number;
  /** Raw `metadata` column value (JSON string with optional `slackMeta` sub-key). */
  metadata: string | null;
}

export interface SlackChronologicalContext {
  readonly renderedMessages: readonly RenderedSlackTranscriptMessage[];
  /** Convenience projection of `renderedMessages[].message`. */
  readonly messages: Message[];
  readonly compactableStartIndex: number;
}

interface SlackBoundaryOptions {
  readonly contextCompactedMessageCount?: number;
  readonly slackContextCompactionWatermarkTs?: string | null;
}

function messageRowsToSlackTranscriptRows(
  rows: MessageRow[],
): SlackTranscriptInputRow[] {
  return rows.map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: row.createdAt,
    metadata: row.metadata,
  }));
}

function hasSlackMetadata(row: MessageRow): boolean {
  return (
    readSlackMetadataFromMessageMetadata(row.metadata, {
      allowFlatLegacy: true,
    }) !== null
  );
}

function filterSlackConversationRowsForActor(
  rows: MessageRow[],
  trustClass: TrustClass | undefined,
): MessageRow[] {
  if (!isUntrustedTrustClass(trustClass)) return rows;
  const nonSlackVisibleRows = filterMessagesForUntrustedActor(rows);
  const nonSlackVisibleIds = new Set(nonSlackVisibleRows.map((row) => row.id));
  return rows.filter((row) => {
    if (hasSlackMetadata(row)) return true;
    return nonSlackVisibleIds.has(row.id);
  });
}

/**
 * Extract the user-facing plain text from an already-parsed `ContentBlock[]`.
 * Only `text` blocks contribute to the rendered transcript line. Tool-use /
 * tool-result / thinking blocks are intentionally elided — they would clutter
 * the Slack-style transcript and the model can already recall them from the
 * surrounding turn structure.
 *
 * Rows with no text blocks (e.g. images, file uploads, pure tool turns) would
 * otherwise render as an empty transcript line like `[14:25 @alice]: `;
 * surface the attachment/tool context instead so the model can tell something
 * was actually said on that turn.
 */
function extractPlainTextFromBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  const placeholderLabels: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    const label = placeholderForBlockType(block.type);
    if (label && !placeholderLabels.includes(label)) {
      placeholderLabels.push(label);
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  return placeholderLabels.join(" ");
}

function placeholderForBlockType(type: ContentBlock["type"]): string | null {
  switch (type) {
    case "image":
      return "[image]";
    case "file":
      return "[file]";
    case "tool_use":
    case "server_tool_use":
      return "[tool call]";
    case "tool_result":
    case "web_search_tool_result":
      return "[tool result]";
    case "thinking":
    case "redacted_thinking":
    case "text":
      return null;
  }
}

/**
 * Convert a persisted row into the {@link RenderableSlackMessage} shape
 * consumed by `renderSlackTranscript`.
 *
 * Legacy pre-upgrade rows (no `slackMeta` sub-key, malformed metadata, etc.)
 * yield `metadata: null`; the renderer then takes its flat-render fallback
 * path and the row stays in chronological order via `createdAt`.
 *
 * Sender labels are emitted only when they add information beyond the role
 * slot:
 * - Reaction rows: always labeled — `@assistant` for the assistant, the real
 *   `slackMeta.displayName` for a known user, or `@user` as a last-resort
 *   subject so the rendered `[time X reacted ...]` line still parses.
 * - Assistant message rows: `null` — the role slot already says "assistant".
 * - User message rows: real `slackMeta.displayName` when available (to
 *   disambiguate speakers in multi-party channels); `null` otherwise so the
 *   renderer drops the redundant `@user` placeholder.
 */
function rowToRenderable(row: SlackTranscriptInputRow): RenderableSlackMessage {
  let slackMeta: ReturnType<typeof readSlackMetadata> = null;
  let provenanceTrustClass: TrustClass | undefined;
  if (row.metadata) {
    try {
      const outer = JSON.parse(row.metadata) as {
        slackMeta?: unknown;
        provenanceTrustClass?: unknown;
      };
      if (typeof outer.slackMeta === "string") {
        slackMeta = readSlackMetadata(outer.slackMeta);
      }
      if (
        outer.provenanceTrustClass === "guardian" ||
        outer.provenanceTrustClass === "trusted_contact" ||
        outer.provenanceTrustClass === "unknown"
      ) {
        provenanceTrustClass = outer.provenanceTrustClass;
      }
    } catch {
      // Malformed metadata — fall through to legacy/null treatment.
    }
  }

  const isReaction = slackMeta?.eventKind === "reaction";
  let senderLabel: string | null;
  if (isReaction) {
    senderLabel =
      row.role === "assistant"
        ? "@assistant"
        : (slackMeta?.displayName ?? "@user");
  } else if (row.role === "assistant") {
    senderLabel = null;
  } else {
    senderLabel = slackMeta?.displayName ?? null;
  }

  // Parse `row.content` once and derive both the structured `contentBlocks`
  // view (for downstream tool-block preservation) and the flattened
  // `plainText` view (used for tag-line rendering) from the same parsed
  // result. Large Slack histories with many tool payloads would otherwise
  // pay a double JSON-parse cost per row.
  let contentBlocks: ContentBlock[] = [];
  let plainText: string;
  try {
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed)) {
      contentBlocks = parsed as ContentBlock[];
      plainText = extractPlainTextFromBlocks(contentBlocks);
    } else if (typeof parsed === "string") {
      plainText = parsed;
    } else {
      plainText = row.content;
    }
  } catch {
    // Plain string row (legacy) — no structured blocks to preserve.
    plainText = row.content;
  }

  // Attachment-only rows (images, files) carry no text block, so the
  // transcript renderer would normally emit them *without* a tag line —
  // the model sees the image but loses sender/timestamp attribution.
  // Synthesize a leading text block carrying the placeholder so the
  // renderer emits `[14:25 @alice]: [image]` and then the image itself.
  // Pure tool-only rows (tool_use / tool_result) are intentionally
  // excluded — those are synthetic turn continuations that should stay
  // tag-line-free, matching the documented behaviour in
  // `buildMessageContentBlocks`.
  const hasTextBlock = contentBlocks.some((b) => b?.type === "text");
  const hasAttachmentBlock = contentBlocks.some(
    (b) => b?.type === "image" || b?.type === "file",
  );
  if (!hasTextBlock && hasAttachmentBlock && plainText !== "") {
    contentBlocks = [{ type: "text", text: plainText }, ...contentBlocks];
  }

  return {
    role: row.role,
    content: plainText,
    metadata: slackMeta,
    senderLabel,
    createdAt: row.createdAt,
    contentBlocks,
    wrapContentForModel:
      row.role === "user" && !isReaction && provenanceTrustClass !== "guardian",
  };
}

const SLACK_ASSISTANT_THREAD_PLACEHOLDER_TEXT = "New Assistant Thread";

function isSlackAssistantThreadPlaceholder(
  message: RenderableSlackMessage,
  canonicalConfiguredBotUserId: string | null,
): boolean {
  if (!canonicalConfiguredBotUserId) return false;
  const metadata = message.metadata;
  if (!metadata || metadata.eventKind !== "message") return false;
  const actorExternalUserId = metadata.actorExternalUserId?.trim();
  if (!actorExternalUserId) return false;

  const canonicalActor =
    canonicalizeInboundIdentity("slack", actorExternalUserId) ??
    actorExternalUserId;
  const isThreadRoot =
    metadata.threadTs === undefined || metadata.threadTs === metadata.channelTs;
  const hasSlackFiles =
    Array.isArray(metadata.slackFiles) && metadata.slackFiles.length > 0;

  return (
    message.role === "user" &&
    canonicalActor === canonicalConfiguredBotUserId &&
    isThreadRoot &&
    !hasSlackFiles &&
    message.content.replace(/\s+/g, " ").trim() ===
      SLACK_ASSISTANT_THREAD_PLACEHOLDER_TEXT
  );
}

function getCanonicalConfiguredSlackBotUserId(): string | null {
  const configuredBotUserId = getConfig().slack.botUserId.trim();
  if (!configuredBotUserId) return null;
  return (
    canonicalizeInboundIdentity("slack", configuredBotUserId) ??
    configuredBotUserId
  );
}

function rowsToRenderableSlackMessages(
  rows: SlackTranscriptInputRow[],
): RenderableSlackMessage[] {
  const canonicalConfiguredBotUserId = getCanonicalConfiguredSlackBotUserId();
  return rows
    .map(rowToRenderable)
    .filter(
      (message) =>
        !isSlackAssistantThreadPlaceholder(
          message,
          canonicalConfiguredBotUserId,
        ),
    );
}

/**
 * Compatibility projection for callers that still need the legacy
 * `Message[] | null` shape. New runtime callers should use
 * `assembleSlackChronologicalContext` so compaction provenance stays
 * available with the rendered messages.
 *
 * Returns `null` when the channel is not Slack (caller should fall through
 * to the default message history). Legacy pre-upgrade rows without
 * `slackMeta` are tolerated: the renderer's flat fallback orders them by
 * `createdAt` alongside post-upgrade rows.
 *
 * For ALL Slack conversations (channels and DMs), `<transport_hints>`
 * injection is suppressed by `applyRuntimeInjections` so the model sees
 * one consistent persisted view instead of a duplicated gateway hint.
 */
export function assembleSlackChronologicalMessages(
  rows: SlackTranscriptInputRow[],
  capabilities: ChannelCapabilities,
): Message[] | null {
  return (
    assembleSlackChronologicalContext(rows, capabilities)?.messages ?? null
  );
}

function maxSlackTs(values: readonly (string | null)[]): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (max === null || compareSlackTs(value, max) > 0) {
      max = value;
    }
  }
  return max;
}

function legacyRowIsAfterWatermark(
  row: SlackTranscriptInputRow,
  watermarkTs: string,
): boolean {
  return compareSlackTs(String(row.createdAt / 1000), watermarkTs) > 0;
}

function filterRowsAfterSlackCompactionBoundary(
  rows: SlackTranscriptInputRow[],
  options: SlackBoundaryOptions,
): SlackTranscriptInputRow[] {
  const fallbackCount = Math.max(
    0,
    Math.floor(options.contextCompactedMessageCount ?? 0),
  );
  const watermarkTs = options.slackContextCompactionWatermarkTs ?? null;
  if (watermarkTs === null) {
    return fallbackCount > 0 ? rows.slice(fallbackCount) : rows;
  }

  return rows.filter((row, index) => {
    const meta = rowToRenderable(row).metadata;
    if (meta) {
      return isSlackTsAfter(meta.channelTs, watermarkTs);
    }
    if (index < fallbackCount) {
      return false;
    }
    return legacyRowIsAfterWatermark(row, watermarkTs);
  });
}

export function getSlackCompactionWatermarkForPrefix(
  context: SlackChronologicalContext | null,
  compactedRenderedMessages: number,
): string | null {
  if (!context || compactedRenderedMessages <= 0) return null;
  const start = context.compactableStartIndex;
  const end = Math.min(
    context.renderedMessages.length,
    start + compactedRenderedMessages,
  );
  if (end <= start) return null;
  return maxSlackTs(
    context.renderedMessages
      .slice(start, end)
      .map((entry) => entry.sourceChannelTs),
  );
}

function assembleSlackChronologicalContext(
  rows: SlackTranscriptInputRow[],
  capabilities: ChannelCapabilities,
  options: {
    contextSummary?: string | null;
  } = {},
): SlackChronologicalContext | null {
  if (capabilities.channel !== "slack") {
    return null;
  }
  const renderable = rowsToRenderableSlackMessages(rows);
  const rendered = renderSlackTranscriptWithProvenance(renderable);
  const contextSummary = options.contextSummary?.trim();
  const renderedMessages = rendered.renderedMessages;
  if (contextSummary) {
    const withSummary: RenderedSlackTranscriptMessage[] = [
      {
        message: createContextSummaryMessage(contextSummary),
        sourceChannelTs: null,
        tagLineProvenance: "none",
      },
      ...renderedMessages,
    ];
    return {
      renderedMessages: withSummary,
      messages: withSummary.map((entry) => entry.message),
      compactableStartIndex: 1,
    };
  }
  return {
    renderedMessages,
    messages: renderedMessages.map((entry) => entry.message),
    compactableStartIndex: 0,
  };
}

/**
 * Compatibility wrapper over `loadSlackChronologicalContext` for callers that
 * still need only the legacy `Message[] | null` projection.
 *
 * When `trustClass` identifies an untrusted actor, non-Slack/private rows
 * are passed through the default trust filter. Slack-tagged rows stay visible
 * because the transcript is scoped to the external Slack chat/thread, which
 * the inbound actor can already read in Slack.
 *
 * Returns `null` when the channel is not Slack — callers should fall
 * through to the default in-memory message history.
 */
export function loadSlackChronologicalMessages(
  conversationId: string,
  capabilities: ChannelCapabilities,
  options: {
    loader?: (id: string) => MessageRow[];
    trustClass?: TrustClass;
    contextSummary?: string | null;
    contextCompactedMessageCount?: number;
    slackContextCompactionWatermarkTs?: string | null;
  } = {},
): Message[] | null {
  return (
    loadSlackChronologicalContext(conversationId, capabilities, options)
      ?.messages ?? null
  );
}

/**
 * Load DB rows for a Slack conversation and project them onto the
 * chronological transcript shape plus source metadata used by compaction.
 *
 * If a Slack timestamp watermark exists, rows at or before that Slack
 * `channelTs` are omitted. When no timestamp watermark exists yet, the
 * legacy `contextCompactedMessageCount` is used as a DB-order fallback so
 * old compacted Slack conversations do not immediately resurrect history;
 * the next successful Slack compaction replaces that count boundary with a
 * durable Slack timestamp watermark.
 */
export function loadSlackChronologicalContext(
  conversationId: string,
  capabilities: ChannelCapabilities,
  options: {
    loader?: (id: string) => MessageRow[];
    trustClass?: TrustClass;
    contextSummary?: string | null;
    contextCompactedMessageCount?: number;
    slackContextCompactionWatermarkTs?: string | null;
  } = {},
): SlackChronologicalContext | null {
  if (capabilities.channel !== "slack") {
    return null;
  }
  const loader = options.loader ?? defaultGetMessages;
  const allRows = loader(conversationId);
  const scopedRows = filterSlackConversationRowsForActor(
    allRows,
    options.trustClass,
  );
  const rows = filterRowsAfterSlackCompactionBoundary(
    messageRowsToSlackTranscriptRows(scopedRows),
    options,
  );
  return assembleSlackChronologicalContext(rows, capabilities, {
    contextSummary: isUntrustedTrustClass(options.trustClass)
      ? null
      : options.contextSummary,
  });
}

// ---------------------------------------------------------------------------
// Active-thread focus block (non-persisted; appended to current user turn)
// ---------------------------------------------------------------------------

/**
 * Detect the "active" Slack thread ts for the current turn.
 *
 * The active thread is the thread the current inbound user message belongs
 * to: scan from newest to oldest and return the `slackMeta.threadTs` of the
 * most recent user row that carries one. Returns `null` when no recent user
 * row sits inside a thread (e.g. the inbound was a top-level channel post,
 * or the conversation has no Slack-tagged user rows yet).
 *
 * Pure: takes pre-mapped renderable rows and returns the ts string only.
 */
function detectActiveThreadTs(rows: RenderableSlackMessage[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role !== "user") continue;
    const meta = row.metadata;
    if (!meta) continue;
    if (meta.eventKind !== "message") continue;
    if (typeof meta.threadTs === "string" && meta.threadTs.length > 0) {
      return meta.threadTs;
    }
    // First non-thread user row wins: the inbound is top-level, no active
    // thread to focus on.
    return null;
  }
  return null;
}

/**
 * Build a focus block listing every message belonging to the active thread:
 * the parent (whose `channelTs` equals `activeThreadTs`) plus every reply
 * (whose `threadTs` equals `activeThreadTs`). Reactions targeting any of
 * those messages are also pulled in via their `targetChannelTs`. Edits and
 * deletions surface through the existing renderer markers.
 *
 * Returns `null` when no rows match (e.g. parent backfill hasn't run yet
 * AND the thread has no replies in storage either) so the caller can skip
 * the empty block. Otherwise returns the rendered XML block ready to append
 * to the user's tail message.
 *
 * Pure: takes pre-mapped renderable rows + a thread ts, returns text only.
 */
function buildActiveThreadBlockFromRenderable(
  rows: RenderableSlackMessage[],
  activeThreadTs: string,
): string | null {
  const members: RenderableSlackMessage[] = [];
  for (const row of rows) {
    const meta = row.metadata;
    if (!meta) continue;
    if (meta.eventKind === "message") {
      if (
        meta.channelTs === activeThreadTs ||
        meta.threadTs === activeThreadTs
      ) {
        members.push(row);
      }
      continue;
    }
    if (
      meta.eventKind === "reaction" &&
      meta.reaction &&
      meta.reaction.targetChannelTs === activeThreadTs
    ) {
      members.push(row);
      continue;
    }
    // Reactions targeting a reply within the thread also belong in the
    // focus block — collect them by checking the reaction target against
    // any thread reply's channelTs we've already accepted. We do this in a
    // second pass below to avoid an O(n^2) inner scan here.
  }

  // Second pass: pull in reactions whose target is one of the already-
  // collected reply messages. Using a Set keeps this O(n).
  const memberChannelTs = new Set(
    members
      .map((m) => m.metadata?.channelTs)
      .filter((v): v is string => typeof v === "string"),
  );
  for (const row of rows) {
    const meta = row.metadata;
    if (!meta || meta.eventKind !== "reaction" || !meta.reaction) continue;
    if (meta.reaction.targetChannelTs === activeThreadTs) continue; // already added
    if (memberChannelTs.has(meta.reaction.targetChannelTs)) {
      members.push(row);
    }
  }

  if (members.length === 0) return null;

  // The active-thread block is flattened to plain text below. User rows keep
  // explicit Slack attribution through the renderer; assistant rows pass
  // through unchanged so the model does not learn a synthetic reply prefix.
  // Unnamed user rows (no real Slack displayName) get a `@user` senderLabel
  // here so their tag line carries attribution through the renderer. Labeled
  // user rows and assistant rows pass through unchanged.
  const labeledMembers = members.map((m) => {
    if (m.role === "assistant") return m;
    if (m.senderLabel !== null) return m;
    return { ...m, senderLabel: "@user" };
  });

  const rendered = renderSlackTranscriptWithProvenance(labeledMembers);
  if (rendered.renderedMessages.length === 0) return null;
  const lines = rendered.renderedMessages
    .map((entry) => extractTagLineTexts([entry.message])[0] ?? "")
    .join("\n");
  return `<active_thread>\n${lines}\n</active_thread>`;
}

/**
 * Build the Slack active-thread focus block from raw rows.
 *
 * Pure assembly entrypoint mirroring `assembleSlackChronologicalMessages`.
 * Returns the rendered `<active_thread>` block as a string, or `null` when:
 *   - the channel is not Slack, OR
 *   - the channel is a Slack DM (DMs do not have threads), OR
 *   - the latest user row is top-level (not in a thread), OR
 *   - no rows belong to the active thread.
 */
export function assembleSlackActiveThreadFocusBlock(
  rows: SlackTranscriptInputRow[],
  capabilities: ChannelCapabilities,
): string | null {
  if (capabilities.channel !== "slack") return null;
  // DMs do not have threads, so the focus block is always a no-op.
  // The gateway sets `chatType: "channel"` for every non-DM Slack
  // conversation and omits the field for DMs, so gate the focus block
  // on the positive `"channel"` match.
  if (capabilities.chatType !== "channel") return null;
  const renderable = rowsToRenderableSlackMessages(rows);
  const activeThreadTs = detectActiveThreadTs(renderable);
  if (!activeThreadTs) return null;
  return buildActiveThreadBlockFromRenderable(renderable, activeThreadTs);
}

/**
 * Loader convenience over `assembleSlackActiveThreadFocusBlock` mirroring
 * `loadSlackChronologicalMessages`. Returns `null` when the channel is not
 * Slack, or when it is a Slack DM (DMs have no threads), so callers can
 * skip the injection entirely without paying for a DB read.
 */
export function loadSlackActiveThreadFocusBlock(
  conversationId: string,
  capabilities: ChannelCapabilities,
  options: {
    loader?: (id: string) => MessageRow[];
    trustClass?: TrustClass;
    contextCompactedMessageCount?: number;
    slackContextCompactionWatermarkTs?: string | null;
  } = {},
): string | null {
  if (capabilities.channel !== "slack") return null;
  if (capabilities.chatType !== "channel") return null;
  const loader = options.loader ?? defaultGetMessages;
  const allRows = loader(conversationId);
  const scopedRows = filterSlackConversationRowsForActor(
    allRows,
    options.trustClass,
  );
  const rows = filterRowsAfterSlackCompactionBoundary(
    messageRowsToSlackTranscriptRows(scopedRows),
    options,
  );
  return assembleSlackActiveThreadFocusBlock(rows, capabilities);
}

/**
 * Controls which runtime injections are applied.
 *
 * - `'full'` (default): all injections are applied.
 * - `'minimal'`: only safety-critical context is injected (unified turn
 *   context, non-interactive marker, voice call control, channel
 *   capabilities). High-token optional blocks (workspace, channel command,
 *   active surface, NOW.md scratchpad) are skipped to reduce context pressure.
 */
export type InjectionMode = "full" | "minimal";

/**
 * Per-turn injection bytes captured so `loadFromDb` can rehydrate historical
 * user messages byte-for-byte after a daemon restart or conversation
 * eviction. Persisting the exact injected text onto message metadata keeps
 * Anthropic's prefix cache anchored to msg[0] instead of invalidating every
 * turn on reload. Any field left `undefined` means that block was not
 * injected on this turn.
 */
export interface RuntimeInjectionBlocks {
  unifiedTurnContext?: string;
  pkbSystemReminder?: string;
  workspaceBlock?: string;
  nowScratchpadBlock?: string;
  pkbContextBlock?: string;
  memoryV2StaticBlock?: string;
  /**
   * UNWRAPPED inner text of the memory-v3 frozen net-new card block the v3
   * injector attached this turn, mirroring v2's unwrapped `memoryInjectedBlock`
   * contract (rehydration re-wraps on use). Undefined when v3 attached no new
   * cards (all-repeat turn, v3 off, or v3 failure). Persisted by the
   * user-prompt-submit hook under `metadata.memoryV3InjectedBlock`
   * (`MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`).
   */
  memoryV3InjectedBlock?: string;
  /**
   * True when memory-v3 superseded v2 as this turn's `<memory>` source — the
   * `memory-v3-live` flag is on AND the v3 injector produced a block (possibly
   * empty-text on an all-repeat turn), i.e. exactly when assembly stripped
   * v2's fresh tail block. The user-prompt-submit hook keys v2's
   * `memoryInjectedBlock` metadata persist off this so a stripped v2 block is
   * never rehydrated back into history on reload.
   */
  memoryV3Active?: boolean;
  /**
   * Composed output of every plugin-registered {@link Injector}, concatenated
   * in ascending `order`. Empty string when every injector opted out (returned
   * `null`). Today the default injectors (`default-injectors` plugin)
   * placeholder-return `null`, so this is only non-empty when a third-party
   * plugin registers an injector that emits content.
   *
   * Populated by {@link composeInjectorChain} during
   * {@link applyRuntimeInjections}. Distinct from the other `blocks` fields
   * because those track specific hardcoded injections today; this field is
   * the extensibility seam for {@link Injector} plugins.
   */
  injectorChainBlock?: string;
}

export interface RuntimeInjectionResult {
  messages: Message[];
  blocks: RuntimeInjectionBlocks;
}

/**
 * Run every {@link Injector} in the chain ({@link getInjectorChain}, already
 * sorted by ascending `order`) and return every non-null block it produced.
 *
 * `runMessages` is the turn's working message array, forwarded to each
 * injector so producers that need the current prompt contents read it from a
 * parameter rather than the shared {@link TurnContext}. Omitted by text-only
 * callers ({@link composeInjectorChain}) that drive the chain without a
 * message array.
 *
 * Injectors returning `null` are omitted from the result. The returned array
 * preserves ascending-`order` sort so downstream callers (notably
 * {@link applyRuntimeInjections}) can group blocks by `placement` and apply
 * them declaratively without losing per-injector ordering within each slot.
 */
async function collectInjectorBlocks(
  ctx: TurnContext,
  runMessages?: Message[],
): Promise<InjectionBlock[]> {
  const out: InjectionBlock[] = [];
  for (const injector of getInjectorChain()) {
    const block = await injector.produce(ctx, runMessages);
    if (block) out.push(block);
  }
  return out;
}

/**
 * Run every registered {@link Injector}'s `produce()` in ascending
 * `order`, concatenate the non-null results into a single block of text,
 * and return it.
 *
 * Separator: blank line between blocks. Injectors returning `null` are
 * skipped entirely (no leading/trailing blank lines). When no injector
 * contributes, the function returns an empty string.
 *
 * Used by tests that assert the concatenation contract and by callers that
 * want a single informational string view of the chain. The canonical
 * integration point is {@link applyRuntimeInjections}, which uses
 * {@link collectInjectorBlocks} + placement-aware application to splice
 * each block into the per-turn message array.
 */
export async function composeInjectorChain(ctx: TurnContext): Promise<string> {
  const blocks = await collectInjectorBlocks(ctx);
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.text.length > 0) pieces.push(block.text);
  }
  return pieces.join("\n\n");
}

/**
 * Default block placement. Kept in sync with {@link InjectionBlock} so
 * blocks produced without an explicit `placement` (e.g. third-party
 * injectors that omit the field) behave predictably.
 */
const DEFAULT_PLACEMENT: InjectionPlacement = "append-user-tail";

/**
 * Count leading memory-prefix blocks on a user message's `content`.
 *
 * Delegates to {@link countMemoryPrefixBlocks} from
 * `memory/graph/conversation-graph-memory.js` — the canonical state-machine
 * for locating the memory-prefix boundary. Reusing it here keeps the
 * PKB-context / PKB-reminder / NOW splice rules aligned on a single source
 * of truth so their ordering relative to any memory prefix is stable and
 * testable.
 */
function countMemoryPrefixBlocksOnContent(content: ContentBlock[]): number {
  return countMemoryPrefixBlocks(content);
}

/**
 * Apply one injector block to a `runMessages` array according to its
 * declared {@link InjectionPlacement}:
 *  - `"prepend-user-tail"` — prepend to the tail user message's content.
 *  - `"append-user-tail"`  — append to the tail user message's content.
 *  - `"after-memory-prefix"` — splice immediately after any leading memory
 *    prefix blocks.
 *  - `"replace-run-messages"` — replace `runMessages` wholesale with
 *    `block.messagesOverride`.
 *
 * Blocks with empty `text` on non-replace placements are no-ops.
 */
function applyInjectionBlock(
  runMessages: Message[],
  block: InjectionBlock,
): Message[] {
  const placement = block.placement ?? DEFAULT_PLACEMENT;

  if (placement === "replace-run-messages") {
    if (!block.messagesOverride) return runMessages;
    return block.messagesOverride;
  }

  if (block.text.length === 0) return runMessages;

  const userTail = runMessages[runMessages.length - 1];
  if (!userTail || userTail.role !== "user") return runMessages;

  const textBlock = { type: "text" as const, text: block.text };

  switch (placement) {
    case "prepend-user-tail":
      return [
        ...runMessages.slice(0, -1),
        { ...userTail, content: [textBlock, ...userTail.content] },
      ];
    case "append-user-tail":
      return [
        ...runMessages.slice(0, -1),
        { ...userTail, content: [...userTail.content, textBlock] },
      ];
    case "after-memory-prefix": {
      const memoryPrefixCount = countMemoryPrefixBlocksOnContent(
        userTail.content,
      );
      return [
        ...runMessages.slice(0, -1),
        {
          ...userTail,
          content: [
            ...userTail.content.slice(0, memoryPrefixCount),
            textBlock,
            ...userTail.content.slice(memoryPrefixCount),
          ],
        },
      ];
    }
  }
}

/**
 * Strip v2's freshly-prepended DYNAMIC memory prefix from the tail user
 * message, preserving every other leading memory-prefix block. Exactly three
 * shapes are v2's to remove:
 *
 *  - `v2WrappedBlock` — the wrapped (`wrapMemoryBlock`) form of the text the
 *    graph-memory wiring prepended this turn, matched by full-block IDENTITY.
 *    A prefix match cannot work here: v3's card-block instruction header is
 *    deliberately byte-identical to v2's `INJECTION_HEADER`
 *    (`memory/v2/injection.ts`), and v2's router block leads with that same
 *    header whenever any summary section is present — the dominant case — so
 *    the two layers' blocks are indistinguishable by any shared prefix.
 *  - legacy `<memory __injected>` text blocks — only v2 ever produced them.
 *  - memory-image groups (`<memory_image …>` opener text, the image block,
 *    the `</memory_image>` closer) — only v2 injects images; v3 card blocks
 *    are text-only.
 *
 * Everything else in the leading memory prefix survives:
 *
 *  - memory-v3's frozen card blocks: a same-turn re-entry assembly (overflow
 *    convergence) sees the tail it assembled on first entry, whose leading
 *    block may be this turn's just-frozen v3 cards (while this re-entry's
 *    injector run produces an EMPTY block — the cards are already claimed by
 *    the everInjected store). Their bytes never equal the v2 identity, so
 *    they are kept without needing to be recognized as v3.
 *  - the `<info>` static block: it counts toward the memory prefix for
 *    splice positioning but is never prepended by `prepareMemory`, so the v2
 *    suppression strip has no business removing it.
 *
 * `v2WrappedBlock === null` (nothing injected this turn, or no live graph
 * handle) still strips the image groups and legacy blocks — both are
 * unambiguously v2's — but leaves every `<memory>` text block in place.
 */
function stripTailV2DynamicMemoryPrefix(
  messages: Message[],
  v2WrappedBlock: string | null,
): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  const prefixCount = countMemoryPrefixBlocksOnContent(last.content);
  if (prefixCount === 0) return messages;
  const content = last.content.filter((block, i) => {
    if (i >= prefixCount) return true;
    // v2's memory-image groups: opener text, injected image, closer text.
    if (block.type === "image") return false;
    if (block.type !== "text") return true;
    if (block.text.startsWith("<memory_image")) return false;
    if (block.text === "</memory_image>") return false;
    // v2's legacy dynamic wrapper.
    if (block.text.startsWith("<memory __injected>\n")) return false;
    // v2's current dynamic block — identity match only (see doc comment).
    return v2WrappedBlock === null || block.text !== v2WrappedBlock;
  });
  if (content.length === last.content.length) return messages;
  return [...messages.slice(0, -1), { ...last, content }];
}

/**
 * Per-turn options accepted by {@link applyRuntimeInjections}.
 *
 * Most fields are layered onto the {@link TurnContext} the caller provides
 * (or onto an ephemeral {@link TurnContext} synthesized for test call sites)
 * as the per-injector inputs consumed by the default injector chain.
 *
 * The active workspace surface, the channel capabilities, the active document
 * list, the channel command context, the voice call-control prompt, the
 * transport hints, the interface label, the channel label, the
 * background-conversation flag, the `<active_subagents>` status block, the
 * `<active_thread>` focus block, the per-turn temporal snapshot (the
 * `<turn_context>` timestamp, the client timezone, and the long-absence gap),
 * and the two config-sourced timezones are not on this bag:
 * `applyRuntimeInjections` resolves them from the live conversation itself (its
 * surface state, `channelCapabilities`, the document store keyed by
 * `conversationId`, its `commandIntent`, its `voiceCallControlPrompt`, its
 * `transportHints`, its turn interface context's `userMessageInterface`
 * (falling back to its recorded `originInterface`, then `web`), its turn
 * channel context's `userMessageChannel` (falling back to its recorded
 * `originChannel`, then `vellum`), its `conversationType`, its
 * `currentTurnTemporalSnapshot`, the subagent manager's children of
 * `conversationId`, and — for the focus block — its persisted Slack
 * compaction boundary (`contextCompactedMessageCount` /
 * `slackContextCompactionWatermarkTs`) and trust class) or from config (the
 * configured user timezone and the detected-timezone fallback), so the
 * orchestrator does not compute or thread any of them per turn.
 *
 * {@link isNonInteractive} is the exception: it is derived from the agent
 * loop's `isInteractive` option (not re-derivable from live conversation
 * state, which can flip mid-turn on SSE reconnect), so the loop resolves it
 * once at turn start and threads it here. The post-compaction re-injection
 * hook receives the same value through its context, keeping the hook free of
 * agent-loop closure state.
 *
 * The remaining unified `<turn_context>` inputs (`actorContext` and
 * `modelProfile`) are flat top-level fields here. They flow through to the
 * matching {@link TurnContext} fields, and the `unified-turn-context`
 * injector builds the block from them — combined with the freshly computed
 * `current_time` timestamp, the turn's frozen client timezone and long-absence
 * gap (from `currentTurnTemporalSnapshot`), the interface and channel labels,
 * and the two self-resolved config timezones — via
 * `buildUnifiedTurnContextBlock`.
 */
export interface RuntimeInjectionOptions {
  /**
   * True when the in-flight turn has no human present to answer clarification
   * questions (resolved by the agent loop from its `isInteractive` option,
   * falling back to the conversation's `hasNoClient` / `headlessLock` state).
   * Drives the `<non_interactive_context>` branch and gates the `background-turn`
   * injector.
   */
  isNonInteractive?: boolean;
  mode?: InjectionMode;
  /**
   * Inbound actor identity and trust fields. Populated only on non-guardian
   * turns; `null`/absent suppresses the actor section of `<turn_context>`.
   */
  actorContext?: InboundActorContext | null;
  /**
   * Human-readable active inference profile, only set when it changed since
   * the last turn (or on the first turn).
   */
  modelProfile?: string | null;
  /**
   * Stable ID for the current request (one per inbound message). Forwarded
   * verbatim onto the {@link TurnContext} handed to plugin-registered
   * {@link Injector}s — it is the one turn-identity field that cannot be
   * recovered from the live conversation, so callers must supply it.
   */
  requestId?: string;
  /**
   * Conversation the turn is scoped to. Drives the live-conversation lookup
   * that sources every self-resolved per-turn field, and is forwarded onto
   * the injector {@link TurnContext}. Required: it is the key every per-turn
   * field resolves through, so callers must name the conversation explicitly.
   */
  conversationId: string;
  /**
   * 0-based turn index forwarded onto the injector {@link TurnContext}.
   * Defaults to the live conversation's `turnCount` when omitted.
   */
  turnIndex?: number;
  /**
   * Trust classification and channel identity for the inbound actor,
   * forwarded onto the injector {@link TurnContext}. Defaults to the live
   * conversation's per-turn (then conversation-level) trust when omitted.
   */
  trust?: TrustContext;
  /**
   * Call site driving the turn, forwarded onto the injector
   * {@link TurnContext}. Defaults to the live conversation's current call
   * site when omitted.
   */
  callSite?: LLMCallSite;
}

/**
 * Last-resort `trust` for the injector {@link TurnContext} when neither the
 * caller nor the live conversation supplies one — an `"unknown"` trust class
 * keyed to the channel so the default-injector chain still runs (test call
 * sites, conversations resolved before their trust context is set).
 */
function fallbackTurnTrust(
  channelCapabilities: ChannelCapabilities | null,
): TrustContext {
  return {
    sourceChannel: channelCapabilities?.channel
      ? (channelCapabilities.channel as TrustContext["sourceChannel"])
      : "vellum",
    trustClass: "unknown",
  };
}

/**
 * Apply the runtime-injection chain to `runMessages`.
 *
 * The canonical per-turn assembly pipeline for every provider call:
 *
 *  1. Resolve the per-turn injection inputs from `options` and the live
 *     conversation, and layer them onto a {@link TurnContext}. The turn
 *     identity (`requestId`, `conversationId`, `turnIndex`, `trust`,
 *     `callSite`) comes from `options` when supplied; `conversationId` is
 *     required, and the rest fall back to the live conversation's values
 *     (with `requestId` defaulting to `conversationId`) so the chain still
 *     runs for test call sites.
 *  2. Drive the default + third-party {@link Injector} chain via
 *     {@link collectInjectorBlocks}.
 *  3. Apply the chain's `"replace-run-messages"` block (Slack chronological
 *     transcript) first so subsequent branches operate on the replaced
 *     tail. When replacement fires, re-prepend any memory-prefix blocks
 *     that `graphMemory.prepareMemory` had attached to the original tail —
 *     the Slack transcript is rendered fresh from persisted rows and
 *     carries no memory prefix of its own.
 *  4. Apply the chain's `"after-memory-prefix"` blocks in ascending
 *     `order`. This runs BEFORE step 5's hardcoded prepends so the
 *     memory-prefix counter sees only the memory blocks on the tail —
 *     any `<channel_capabilities>` / `<channel_command_context>` /
 *     `<transport_hints>` prepended first would push the count to zero
 *     and force PKB / NOW to splice at the top of the tail. Within the
 *     after-memory block, each successive splice lands at the memory
 *     boundary, pushing earlier splices further from memory — so
 *     higher-`order` blocks end up closer to the memory prefix.
 *  5. Run the remaining hardcoded branches (`isNonInteractive`,
 *     `voiceCallControlPrompt`, `activeSurface`, `channelCapabilities`,
 *     `channelCommandContext`, `transportHints`) in their historical order.
 *     `voiceCallControlPrompt`, `activeSurface`, `channelCapabilities`,
 *     `channelCommandContext`, and `transportHints` are sourced from the live
 *     conversation rather than `options`.
 *  6. Finally, apply the chain's remaining blocks by placement:
 *     `"append-user-tail"` in ascending `order`, then `"prepend-user-tail"`
 *     in descending `order` so the lowest-`order` prepend lands topmost in
 *     the user tail content.
 *
 * Returns the final message array plus a `blocks` object holding the exact
 * injected text for each captured block — callers persist those bytes to
 * message metadata for later byte-exact rehydration.
 */
export async function applyRuntimeInjections(
  runMessages: Message[],
  options: RuntimeInjectionOptions,
): Promise<RuntimeInjectionResult> {
  const mode = options.mode ?? "full";

  const conversationId = options.conversationId;

  // Resolve the live conversation (or subagent) once and source every per-turn
  // field below from it rather than from orchestrator-computed options.
  const liveConversation = findConversationOrSubagent(conversationId);

  const channelCapabilities = liveConversation?.channelCapabilities ?? null;
  const slackConversation = channelCapabilities?.channel === "slack";

  const activeDocuments = buildActiveDocuments(conversationId);

  const channelCommandContext = liveConversation?.commandIntent ?? null;
  const voiceCallControlPrompt =
    liveConversation?.voiceCallControlPrompt ?? null;
  const transportHints = liveConversation?.transportHints ?? null;
  const interfaceName = liveConversation
    ? (liveConversation.currentTurnInterfaceContext?.userMessageInterface ??
      liveConversation.originInterface ??
      "web")
    : undefined;
  const channelName = liveConversation
    ? (liveConversation.currentTurnChannelContext?.userMessageChannel ??
      liveConversation.originChannel ??
      "vellum")
    : undefined;
  const isBackgroundConversation = isBackgroundConversationType(
    liveConversation?.conversationType,
  );
  const isNonInteractive = options.isNonInteractive ?? false;

  // The configured user timezone and the server-detected fallback are stable
  // settings, so they are read from config here rather than threaded through
  // `options`. The client-reported timezone and the long-absence gap are
  // sourced from the conversation's frozen `currentTurnTemporalSnapshot`
  // instead: the loop captures them at turn start so the live
  // `Conversation.clientTimezone` (overwritten when a newer message for the
  // same conversation arrives mid-turn) cannot leak a queued message's timezone
  // into the in-flight turn. The `unified-turn-context` injector compares the
  // configured and client timezones to surface a mismatch affordance.
  //
  // `current_time` is computed fresh here from those timezone inputs rather
  // than frozen, so every assembly — including post-compaction re-injections
  // later in a long turn — reflects the current wall clock. The snapshot's
  // presence gates the block: the timestamp (and therefore the whole
  // `<turn_context>` injection) is only produced for turns the loop has frozen
  // a snapshot for.
  const uiConfig = getConfig().ui;
  const configuredUserTimezone = canonicalizeTimeZone(
    uiConfig?.userTimezone ?? null,
  );
  const detectedTimezone = canonicalizeTimeZone(
    uiConfig?.detectedTimezone ?? null,
  );
  const temporalSnapshot = liveConversation?.currentTurnTemporalSnapshot;
  const clientTimezone = canonicalizeTimeZone(
    temporalSnapshot?.clientTimezone ?? null,
  );
  const timestamp = temporalSnapshot
    ? formatTurnTimestamp({
        configuredUserTimeZone: configuredUserTimezone,
        clientTimezone,
        detectedTimezone,
      })
    : undefined;
  const timeSinceLastMessage = temporalSnapshot?.timeSinceLastMessage ?? null;

  // The `<active_subagents>` status block is sourced from the live subagent
  // manager's children of this conversation. Skipped when this conversation is
  // itself a subagent (no nesting) or has no children.
  const subagentStatusBlock = liveConversation?.isSubagent
    ? null
    : buildSubagentStatusBlock(
        getSubagentManager().getChildrenOf(conversationId),
      );

  // The `<active_thread>` focus block lists the messages of the thread the
  // current inbound user message belongs to. The loader short-circuits to
  // null for non-Slack and Slack-DM conversations before any DB read, and
  // bounds the thread rows by the conversation's persisted Slack compaction
  // boundary (raw `contextCompactedMessageCount` / watermark) so rows already
  // folded into the summary are excluded.
  const slackActiveThreadFocusBlock = channelCapabilities
    ? loadSlackActiveThreadFocusBlock(conversationId, channelCapabilities, {
        trustClass: liveConversation?.trustContext?.trustClass,
        contextCompactedMessageCount:
          liveConversation?.contextCompactedMessageCount,
        slackContextCompactionWatermarkTs:
          liveConversation?.slackContextCompactionWatermarkTs,
      })
    : null;

  // The Slack chronological transcript that the `slack-messages` injector
  // splices in to replace the default `runMessages` history. Rendered fresh
  // from persisted rows scoped by the conversation's Slack compaction
  // boundary: once compaction runs, the watermark advances and the summary
  // message is prepended, so the load returns the compacted view rather than
  // resurrecting folded history. Sourced from the live conversation so every
  // re-injection (including the post-compaction hook) reflects the current
  // boundary without the orchestrator threading a snapshot in.
  const slackChronologicalMessages = channelCapabilities
    ? loadSlackChronologicalMessages(conversationId, channelCapabilities, {
        trustClass: liveConversation?.trustContext?.trustClass,
        contextSummary: liveConversation?.contextSummary,
        contextCompactedMessageCount:
          liveConversation?.contextCompactedMessageCount,
        slackContextCompactionWatermarkTs:
          liveConversation?.slackContextCompactionWatermarkTs,
      })
    : null;

  // Assemble the per-turn TurnContext handed to the injector chain. The
  // turn-identity fields come from `options` when supplied; `requestId` is the
  // only one the caller must provide, since the other three are recovered from
  // the live conversation that backs this turn (the same instance the per-turn
  // injection inputs below are sourced from). Test call sites that omit the
  // live conversation can still drive the chain by passing the identity fields
  // directly. The per-injector inputs are layered on last so they win.
  const injectionInputs = {
    mode: options.mode,
    subagentStatusBlock,
    channelCapabilities,
    slackChronologicalMessages,
    slackActiveThreadFocusBlock,
    isNonInteractive: options.isNonInteractive,
    isBackgroundConversation,
    activeDocuments,
    timestamp,
    interfaceName,
    channelName,
    actorContext: options.actorContext,
    configuredUserTimezone,
    clientTimezone,
    detectedTimezone,
    timeSinceLastMessage,
    modelProfile: options.modelProfile,
  };
  const turnCtx: TurnContext = {
    requestId: options.requestId ?? conversationId,
    conversationId,
    turnIndex: options.turnIndex ?? liveConversation?.turnCount ?? 0,
    trust:
      options.trust ??
      liveConversation?.currentTurnTrustContext ??
      liveConversation?.trustContext ??
      fallbackTurnTrust(channelCapabilities),
    callSite: options.callSite ?? liveConversation?.currentCallSite,
    ...injectionInputs,
  };

  const chainBlocks = await collectInjectorBlocks(turnCtx, runMessages);

  // Split the chain output by placement so the downstream assembly can
  // process each slot with the correct ordering rule.
  const prepends: InjectionBlock[] = [];
  const appends: InjectionBlock[] = [];
  const afterMemory: InjectionBlock[] = [];
  let replaceBlock: InjectionBlock | null = null;
  for (const block of chainBlocks) {
    switch (block.placement ?? "append-user-tail") {
      case "replace-run-messages":
        // Later replace-run-messages blocks would overwrite earlier ones;
        // the default chain only registers one (the Slack transcript).
        replaceBlock = block;
        break;
      case "after-memory-prefix":
        afterMemory.push(block);
        break;
      case "prepend-user-tail":
        prepends.push(block);
        break;
      case "append-user-tail":
        appends.push(block);
        break;
    }
  }

  // Track captured text for metadata persistence. Each field corresponds
  // to a specific default-injector block id so the loop below can pick up
  // the right capture without re-rendering.
  //
  // The capture is gated on the tail actually being a user message — if it
  // isn't, `applyInjectionBlock` no-ops the block and no content is actually
  // injected, so the persisted metadata must be undefined.
  let turnContextCaptured: string | undefined;
  let workspaceCaptured: string | undefined;
  let nowScratchpadCaptured: string | undefined;
  let pkbContextCaptured: string | undefined;
  let pkbSystemReminderCaptured: string | undefined;
  let memoryV2StaticCaptured: string | undefined;
  let memoryV3Captured: string | undefined;
  const initialTail = runMessages[runMessages.length - 1];
  const initialTailIsUser = !!initialTail && initialTail.role === "user";
  if (initialTailIsUser) {
    for (const block of chainBlocks) {
      switch (block.id) {
        case "unified-turn-context":
          turnContextCaptured = block.text;
          break;
        case "workspace-context":
          workspaceCaptured = block.text;
          break;
        case "now-md":
          nowScratchpadCaptured = block.text;
          break;
        case "pkb-context":
          pkbContextCaptured = block.text;
          break;
        case "pkb-reminder":
          pkbSystemReminderCaptured = block.text;
          break;
        case "memory-v2-static":
          memoryV2StaticCaptured = block.text;
          break;
        case MEMORY_V3_BLOCK_ID: {
          // The v3 frozen card block is persisted UNWRAPPED (the v2
          // `memoryInjectedBlock` contract — rehydration re-wraps on use).
          // An empty-text block (all-repeat turn) attaches no content, so
          // nothing is captured for persistence either.
          if (block.text.length > 0) {
            memoryV3Captured = unwrapMemoryBlock(block.text);
          }
          // Attachment is guaranteed from here (user tail — the gate this
          // capture loop runs under), so commit the injector's deferred
          // everInjected-store write. On a non-user tail the block silently
          // no-ops in `applyInjectionBlock`, and skipping the commit keeps
          // the store from claiming cards that never attached (which would
          // suppress them until compaction).
          const commit = block.meta?.[MEMORY_V3_COMMIT_META_KEY];
          if (typeof commit === "function") {
            (commit as () => void)();
          }
          break;
        }
      }
    }
  }

  // Compose the block text into a single informational string for
  // `injectorChainBlock` — a composed view of every injector that fired on
  // the turn, including defaults, so downstream observers see the full set.
  const injectorChainPieces: string[] = [];
  for (const block of chainBlocks) {
    if (block.text.length > 0) injectorChainPieces.push(block.text);
  }
  const injectorChainBlock =
    injectorChainPieces.length > 0
      ? injectorChainPieces.join("\n\n")
      : undefined;

  // ── Step 0: memory-v3 ephemeral-spotlight strip + v2 tail suppression ──
  //
  // Spotlight strip (unconditional): the `<memory_spotlight>` block is
  // ephemeral by contract — re-rendered at the current tail each turn — so any
  // spotlight riding history from a previous turn is stale and is removed
  // here. This is a SCOPED strip of only that block id: the frozen `<memory>`
  // card blocks on historical messages are untouched (the cache contract).
  // With the v3 flag off no spotlight blocks exist and this is a content
  // no-op, keeping the v2 path bit-for-bit identical.
  let runMessagesForAssembly = stripSpotlightInjections(runMessages);

  // v2 suppression: when the `memory-v3-live` flag is on AND the v3 injector
  // produced a block this turn (possibly empty-text on an all-repeat turn), v3
  // owns the `<memory>` layer. v2's `prepareMemory` already prepended its own
  // fresh `<memory>` block to the tail user message — strip the TAIL's v2
  // dynamic prefix only, so the v3 `after-memory-prefix` block (Step 2) lands
  // at the top of the tail with no v2 prefix ahead of it. Historical user
  // messages keep their memory blocks byte-identical: frozen v3 card blocks
  // from prior turns AND pre-cutover v2 blocks both ride the cached prefix
  // (the old whole-layer `stripAllMemoryInjections` replace is gone). The
  // strip discriminates v2's dynamic block by IDENTITY ({@link
  // stripTailV2DynamicMemoryPrefix}): the live graph handle holds the exact
  // text the wiring layer prepended this turn, so a re-entry tail's
  // just-frozen v3 card block (and the `<info>` static block) survive even
  // though v2 and v3 blocks share identical wrapper + header bytes — the v2
  // prefix this strip exists to remove was already stripped on first entry.
  // Keyed off the v3 block being present (not the flag alone) so a v3 failure
  // (`produce()` → null) leaves v2's block intact — fallback rather than a
  // memory-less turn. Idempotent: re-injection sites that already stripped
  // see no change. Flag off → bit-for-bit identical to the v2 path.
  const suppressV2MemoryForV3 = isAssistantFeatureFlagEnabled(
    "memory-v3-live",
    getConfig(),
  );
  const v3ProducedBlock = afterMemory.some((b) => b.id === MEMORY_V3_BLOCK_ID);
  const memoryV3Active = suppressV2MemoryForV3 && v3ProducedBlock;
  if (memoryV3Active) {
    const v2DynamicText =
      getLiveGraphMemory(conversationId)?.lastInjectedBlockText ?? null;
    runMessagesForAssembly = stripTailV2DynamicMemoryPrefix(
      runMessagesForAssembly,
      v2DynamicText === null ? null : wrapMemoryBlock(v2DynamicText),
    );
  }

  let result = runMessagesForAssembly;

  // ── Step 1: Slack chronological replacement (chain "replace" block) ──
  if (replaceBlock && replaceBlock.messagesOverride) {
    // `graphMemory.prepareMemory` prepends a `<memory __injected>` block
    // (and any memory-image groups) to the last user message before
    // runtime assembly runs. The Slack transcript is freshly rendered
    // from persisted rows and has no such prefix, so swap it in and then
    // re-prepend the captured prefix onto the new tail user message.
    const carriedMemoryBlocks = extractMemoryPrefixBlocks(
      runMessagesForAssembly,
    );
    result = replaceBlock.messagesOverride;
    if (carriedMemoryBlocks.length > 0) {
      const slackTail = result[result.length - 1];
      if (slackTail && slackTail.role === "user") {
        result = [
          ...result.slice(0, -1),
          {
            ...slackTail,
            content: [...carriedMemoryBlocks, ...slackTail.content],
          },
        ];
      }
    }
  }

  // ── Step 2: after-memory-prefix chain blocks ──
  // These splice relative to the memory-prefix count on the tail content,
  // so they must run BEFORE the hardcoded prepends in step 3. Otherwise
  // any prepended `<channel_capabilities>` / `<channel_command_context>` /
  // `<transport_hints>` (none of which are memory-prefix blocks) would
  // drop the count to 0 and PKB / NOW would splice at the very top of
  // the tail instead of immediately after memory.
  //
  // Ascending `order`: each splice lands at the memory-prefix boundary,
  // pushing any previously-spliced block one slot further from memory.
  // So higher-`order` blocks end up closer to the memory prefix.
  for (const block of afterMemory) {
    result = applyInjectionBlock(result, block);
  }

  // ── Step 3: hardcoded branches that stayed outside the injector chain ──
  // Their order here is load-bearing: each branch may mutate the tail
  // user message, so reordering changes how they interleave.

  // For non-interactive conversations (scheduled jobs, work items), instruct the
  // model to never ask for clarification — there is no human present to answer.
  if (isNonInteractive) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === "user") {
      result = [
        ...result.slice(0, -1),
        {
          ...userTail,
          content: [
            ...userTail.content,
            {
              type: "text" as const,
              text: "<non_interactive_context>\nNon-interactive scheduled task — do not ask for clarification or confirmation. Follow the instructions exactly using your best judgment. If recalled memory contains conflicting notes, prefer the explicit instruction in this message.\n</non_interactive_context>",
            },
          ],
        },
      ];
    }
  }

  if (voiceCallControlPrompt) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === "user") {
      result = [
        ...result.slice(0, -1),
        injectVoiceCallControlContext(userTail, voiceCallControlPrompt),
      ];
    }
  }

  if (mode === "full") {
    // Source the active workspace surface from the live conversation's surface
    // state rather than from a per-turn option computed by the orchestrator.
    const activeSurface = liveConversation
      ? buildActiveSurfaceContext({
          currentActiveSurfaceId: liveConversation.currentActiveSurfaceId,
          currentPage: liveConversation.currentPage,
          surfaceState: liveConversation.surfaceState,
        })
      : null;
    if (activeSurface) {
      const userTail = result[result.length - 1];
      if (userTail && userTail.role === "user") {
        result = [
          ...result.slice(0, -1),
          injectActiveSurfaceContext(userTail, activeSurface),
        ];
      }
    }
  }

  if (channelCapabilities) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === "user") {
      result = [
        ...result.slice(0, -1),
        injectChannelCapabilityContext(userTail, channelCapabilities),
      ];
    }
  }

  if (mode === "full" && channelCommandContext) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === "user") {
      result = [
        ...result.slice(0, -1),
        injectChannelCommandContext(userTail, channelCommandContext),
      ];
    }
  }

  // Slack conversations (both channels and DMs) build their own
  // chronological transcript from persisted messages and intentionally do
  // not receive the per-turn `<transport_hints>` block — the rendered
  // history already covers the active thread / DM, so duplicating it
  // would confuse the model. Other channels (telegram, email, etc.) keep
  // the existing injection.
  if (
    mode === "full" &&
    !slackConversation &&
    transportHints &&
    transportHints.length > 0
  ) {
    const userTail = result[result.length - 1];
    if (userTail && userTail.role === "user") {
      result = [
        ...result.slice(0, -1),
        injectTransportHints(userTail, transportHints),
      ];
    }
  }

  // ── Step 4: apply remaining chain blocks by placement ──
  // append-user-tail: ascending `order` so lower-order blocks come first
  // in the append sequence.
  for (const block of appends) {
    result = applyInjectionBlock(result, block);
  }

  // prepend-user-tail: descending `order` so the lowest-order block lands
  // topmost in the tail content (each successive prepend pushes the
  // previous one further down).
  for (let i = prepends.length - 1; i >= 0; i--) {
    result = applyInjectionBlock(result, prepends[i]);
  }

  return {
    messages: result,
    blocks: {
      unifiedTurnContext: turnContextCaptured,
      pkbSystemReminder: pkbSystemReminderCaptured,
      workspaceBlock: workspaceCaptured,
      nowScratchpadBlock: nowScratchpadCaptured,
      pkbContextBlock: pkbContextCaptured,
      memoryV2StaticBlock: memoryV2StaticCaptured,
      memoryV3InjectedBlock: memoryV3Captured,
      memoryV3Active,
      injectorChainBlock,
    },
  };
}
