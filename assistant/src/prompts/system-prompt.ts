import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getCachedManagedConnections } from "../credential-execution/managed-catalog.js";
import type { ChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { listConnections } from "../oauth/oauth-store.js";
import type { OnboardingContext } from "../types/onboarding-context.js";
import { resolveBundledDir } from "../util/bundled-asset.js";
import { getLogger } from "../util/logger.js";
import {
  getConversationsDir,
  getWorkspaceDir,
  getWorkspacePromptPath,
} from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";
import { cleanupBootstrapFiles } from "./bootstrap-cleanup.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./cache-boundary.js";
import { normalizeOnboardingContext } from "./normalize-onboarding.js";
import {
  resolveGuardianPersona,
  resolveUserSlug,
} from "./persona-resolver.js";
import { renderWorkspaceSections } from "./sections.js";
import { isTemplateContent } from "./template-detection.js";

export { isTemplateContent };

export { SYSTEM_PROMPT_CACHE_BOUNDARY };

const BOOTSTRAP_VOICE_BLOCKS: Record<string, string> = {
  grounded:
    "## Voice\nCalm, direct, precise. No filler. Lead with the thing, explain if needed. Opinions stated plainly.",
  warm: "## Voice\nFriendly and easy. Match their energy quickly. Warmth comes through in word choice, not in announcements. Warmth comes through in how you engage, not in hedging about yourself. Never say you're new, running on instinct, or still figuring yourself out.",
  energetic:
    "## Voice\nFast and generative. Lean into momentum. Enthusiasm is in the pace, not the exclamations.",
  poetic:
    "## Voice\nThoughtful and unhurried. Notice things. Word choice matters. Don't rush to close — sometimes the observation is the value.",
};

/**
 * Maps onboarding cohort identifiers to their cohort-specific bootstrap
 * template filenames.  When a cohort key is present in OnboardingContext,
 * `maybeReseedBootstrapForCohort` swaps the generic BOOTSTRAP.md with the
 * cohort-specific variant — but only if the workspace file is still pristine.
 */
const COHORT_BOOTSTRAP_TEMPLATES: Record<string, string> = {
  "content-automation": "BOOTSTRAP-CONTENT-AUTOMATION.md",
};

const log = getLogger("system-prompt");

const PROMPT_FILES = ["IDENTITY.md", "SOUL.md"] as const;

function hasPopulatedUsersDir(): boolean {
  try {
    const usersDir = join(getWorkspaceDir(), "users");
    if (!existsSync(usersDir)) return false;
    return readdirSync(usersDir).length > 0;
  } catch {
    return false;
  }
}

function hasExistingConversations(): boolean {
  try {
    const convDir = getConversationsDir();
    if (!existsSync(convDir)) return false;
    return readdirSync(convDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy template prompt files into the data directory if they don't already exist.
 * Called once during daemon startup so users always have discoverable files to edit.
 *
 * BOOTSTRAP.md is handled separately: it is only created when *none* of the core
 * prompt files existed beforehand (a truly fresh install).  This prevents the
 * daemon from recreating the file on every restart after the user deletes it to
 * signal that onboarding is complete.
 */
export function ensurePromptFiles(): void {
  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );

  // Track whether this is a fresh workspace.  A workspace counts as fresh
  // only when none of these signals are present: core prompt files, a
  // populated `users/` directory, or existing conversations.  Upgraded
  // workspaces that dropped USER.md but still carry personas or history
  // would otherwise be mistaken for fresh installs and re-trigger
  // onboarding.
  const isFirstRun =
    PROMPT_FILES.every((file) => !existsSync(getWorkspacePromptPath(file))) &&
    !hasPopulatedUsersDir() &&
    !hasExistingConversations();

  for (const file of PROMPT_FILES) {
    const dest = getWorkspacePromptPath(file);
    if (existsSync(dest)) continue;

    const src = join(templatesDir, file);
    try {
      if (!existsSync(src)) {
        log.warn({ src }, "Prompt template not found, skipping");
        continue;
      }
      copyFileSync(src, dest);
      log.info({ file, dest }, "Created prompt file from template");
    } catch (err) {
      log.warn({ err, file }, "Failed to create prompt file from template");
    }
  }

  // Only seed BOOTSTRAP.md on a truly fresh install so that deleting it
  // reliably signals onboarding completion across daemon restarts.
  if (isFirstRun) {
    const bootstrapDest = getWorkspacePromptPath("BOOTSTRAP.md");
    if (!existsSync(bootstrapDest)) {
      const bootstrapSrc = join(templatesDir, "BOOTSTRAP.md");
      try {
        if (existsSync(bootstrapSrc)) {
          copyFileSync(bootstrapSrc, bootstrapDest);
          log.info(
            { file: "BOOTSTRAP.md", dest: bootstrapDest },
            "Created BOOTSTRAP.md for first-run onboarding",
          );
        }
      } catch (err) {
        log.warn(
          { err, file: "BOOTSTRAP.md" },
          "Failed to create BOOTSTRAP.md from template",
        );
      }
    }

    // Also seed BOOTSTRAP-REFERENCE.md (ui_show payloads read on-demand)
    const refDest = getWorkspacePromptPath("BOOTSTRAP-REFERENCE.md");
    if (!existsSync(refDest)) {
      const refSrc = join(templatesDir, "BOOTSTRAP-REFERENCE.md");
      try {
        if (existsSync(refSrc)) {
          copyFileSync(refSrc, refDest);
          log.info(
            { file: "BOOTSTRAP-REFERENCE.md", dest: refDest },
            "Created BOOTSTRAP-REFERENCE.md for first-run onboarding",
          );
        }
      } catch (err) {
        log.warn(
          { err, file: "BOOTSTRAP-REFERENCE.md" },
          "Failed to create BOOTSTRAP-REFERENCE.md from template",
        );
      }
    }
  }

  // Auto-delete stale BOOTSTRAP.md at startup.  The model is instructed to
  // delete it at the end of the first conversation, but if the user closes
  // the app or starts a new thread before the model gets another turn, it
  // never gets the chance.  If BOOTSTRAP.md still exists but prior
  // conversations are present, the onboarding window has passed — clean up.
  const bootstrapCleanup = getWorkspacePromptPath("BOOTSTRAP.md");
  if (!isFirstRun && existsSync(bootstrapCleanup)) {
    const convDir = getConversationsDir();
    try {
      if (existsSync(convDir) && readdirSync(convDir).length > 0) {
        cleanupBootstrapFiles("prior conversations exist");
      }
    } catch (err) {
      log.warn({ err }, "Failed to auto-delete stale BOOTSTRAP.md");
    }
  }

  // Seed HEARTBEAT.md — always created if missing so the heartbeat service
  // has a meaningful checklist from the start.  Kept out of PROMPT_FILES
  // because it's operational, not identity context.
  const heartbeatDest = getWorkspacePromptPath("HEARTBEAT.md");
  if (!existsSync(heartbeatDest)) {
    const heartbeatSrc = join(templatesDir, "HEARTBEAT.md");
    try {
      if (existsSync(heartbeatSrc)) {
        copyFileSync(heartbeatSrc, heartbeatDest);
        log.info(
          { file: "HEARTBEAT.md", dest: heartbeatDest },
          "Created HEARTBEAT.md from template",
        );
      }
    } catch (err) {
      log.warn(
        { err, file: "HEARTBEAT.md" },
        "Failed to create HEARTBEAT.md from template",
      );
    }
  }

  // The `remember` tool handles scratchpad-style memory writes directly to the graph.

  // Seed users/default.md persona template
  try {
    const usersDir = join(getWorkspaceDir(), "users");
    mkdirSync(usersDir, { recursive: true });
    const defaultPersonaSrc = join(templatesDir, "users", "default.md");
    const defaultPersonaDest = join(usersDir, "default.md");
    if (!existsSync(defaultPersonaDest) && existsSync(defaultPersonaSrc)) {
      copyFileSync(defaultPersonaSrc, defaultPersonaDest);
      log.info(
        { file: "users/default.md", dest: defaultPersonaDest },
        "Created default persona file from template",
      );
    }
  } catch (err) {
    log.warn(
      { err, file: "users/default.md" },
      "Failed to create default persona file from template",
    );
  }
}

/**
 * One-shot swap: if the workspace BOOTSTRAP.md is still the unmodified generic
 * template AND a cohort-specific template exists, overwrite the workspace file
 * with the cohort variant.  No-op when BOOTSTRAP.md has been deleted, modified,
 * or the cohort has no mapped template.
 */
export function maybeReseedBootstrapForCohort(cohort: string): void {
  const templateFileName = COHORT_BOOTSTRAP_TEMPLATES[cohort];
  if (!templateFileName) return;

  const bootstrapPath = getWorkspacePromptPath("BOOTSTRAP.md");
  if (!existsSync(bootstrapPath)) return;

  const currentContent = readPromptFile(bootstrapPath);
  // Compare against the GENERIC "BOOTSTRAP.md" template, not the cohort-
  // specific one.  After the swap, the workspace content no longer matches
  // the generic template, so this guard returns false on subsequent calls —
  // making the swap idempotent.  Do NOT change the comparison target to the
  // cohort template filename; that would re-swap on every prompt build.
  if (!isTemplateContent(currentContent, "BOOTSTRAP.md")) return;

  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );
  const cohortTemplatePath = join(templatesDir, templateFileName);
  if (!existsSync(cohortTemplatePath)) {
    log.warn(
      { cohort, templateFileName },
      "Cohort bootstrap template not found, keeping generic BOOTSTRAP.md",
    );
    return;
  }

  try {
    const cohortContent = readFileSync(cohortTemplatePath, "utf-8");
    writeFileSync(bootstrapPath, cohortContent, "utf-8");
    log.info(
      { cohort, templateFileName },
      "Replaced generic BOOTSTRAP.md with cohort-specific template",
    );
  } catch (err) {
    log.warn(
      { err, cohort, templateFileName },
      "Failed to reseed BOOTSTRAP.md for cohort",
    );
  }
}

/**
 * Build the system prompt from ~/.vellum prompt files.
 *
 * Composition:
 *   1. Bundled static sections (`renderWorkspaceSections`), in id-sort
 *      order.  Includes `08-identity` (IDENTITY.md), `09-soul`
 *      (SOUL.md), `10-user-persona` (`users/{{userSlug}}.md` →
 *      `users/default.md`), and `11-channel-persona`
 *      (`channels/{{channelSlug}}.md`), all backed by workspace files.
 *   2. Accumulated VOICE.md, after the cache boundary.
 *   3. If BOOTSTRAP.md exists, the first-run ritual block.
 */
export interface BuildSystemPromptOptions {
  hasNoClient?: boolean;
  excludeBootstrap?: boolean;
  excludeCustomPrefix?: boolean;
  trustContext?: TrustContext;
  channelCapabilities?: ChannelCapabilities;
  onboardingContext?: OnboardingContext;
}

/**
 * Sentinel that separates the static instruction prefix (stable across turns)
 * from the dynamic workspace suffix (changes when workspace files are edited).
 *
 * The Anthropic provider splits on this marker to create two system-prompt
 * cache blocks so that static instructions stay cached even when workspace
 * files change between turns.
 */
export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  // One-shot cohort swap: if the user has a cohort and BOOTSTRAP.md is still
  // the generic template, replace it with the cohort-specific variant before
  // the prompt reads the file.
  if (options?.onboardingContext?.cohort) {
    maybeReseedBootstrapForCohort(options.onboardingContext.cohort);
  }

  // Read BOOTSTRAP.md up front so `includeBootstrap` is on `ctx` for the
  // `08-identity` section transform, which gates the unmodified IDENTITY.md
  // template behind bootstrap presence.
  const bootstrap = readPromptFile(getWorkspacePromptPath("BOOTSTRAP.md"));
  const includeBootstrap = !!bootstrap && !options?.excludeBootstrap;

  // Slugs used by the persona sections (`10-user-persona`,
  // `11-channel-persona`) and the BOOTSTRAP block.  `userSlug` is the
  // raw slug derived from the caller's trust context (falling back to
  // the guardian's contact, then to "default" when nothing resolves);
  // `users/<slug>.md → users/default.md` fallback lives in the
  // section's `workspacePath` array.  `channelSlug` is the channel
  // identifier from `channelCapabilities`, defaulting to "vellum".
  const userSlug = resolveUserSlug(options?.trustContext) ?? "default";
  const channelSlug = options?.channelCapabilities?.channel ?? "vellum";

  // Section render context.  Workspace section frontmatter `enabled:`
  // predicates, `{{key}}` / `{{#flag}}...{{/flag}}` body interpolation,
  // and `{{key}}` paths inside `workspacePath` all resolve against this
  // map, so anything the renderer needs to see (runtime gates, slugs,
  // paths) must be lifted onto `ctx` rather than branched on at the
  // call site.  Mustache section tags `{{#flag}}` / `{{^flag}}` coerce
  // `ctx[flag]` to boolean via `Boolean(...)`, so options that are
  // undefined (caller didn't pass them) behave identically to false —
  // no explicit normalization needed; `...options` is enough.
  const ctx = {
    ...options,
    isContainerized: getIsContainerized(),
    workspaceDir: getWorkspaceDir(),
    includeBootstrap,
    userSlug,
    channelSlug,
  };

  // Single array.  Everything pushed before `dynamicStart` lands in the
  // static (cached) prefix; everything after lands in the dynamic suffix.
  // The two halves are joined around `SYSTEM_PROMPT_CACHE_BOUNDARY` so the
  // Anthropic provider can key its prompt cache on the prefix.
  //
  // IDENTITY.md / SOUL.md / user persona / channel persona all render
  // via workspace-backed bundled sections (`08-identity` / `09-soul` /
  // `10-user-persona` / `11-channel-persona`) inside
  // `renderWorkspaceSections`, so they sit in the static prefix in that
  // order.
  const systemParts: string[] = [...renderWorkspaceSections(ctx)];
  const dynamicStart = systemParts.length;

  // Surface accumulated voice markers when VOICE.md has content.
  const voiceContent = readPromptFile(getWorkspacePromptPath("VOICE.md"));
  if (voiceContent) {
    systemParts.push("# Voice Profile\n\n" + voiceContent);
  }

  if (includeBootstrap) {
    const bootstrapWithSlug = bootstrap.replaceAll(
      "{{USER_PERSONA_FILE}}",
      `${userSlug}.md`,
    );
    let bootstrapContent = bootstrapWithSlug;
    const voiceBlock = options?.onboardingContext?.tone
      ? BOOTSTRAP_VOICE_BLOCKS[options.onboardingContext.tone]
      : undefined;
    if (voiceBlock) {
      bootstrapContent = voiceBlock + "\n\n" + bootstrapContent;
    }
    systemParts.push(
      "# First-Run Ritual\n\n" +
        "BOOTSTRAP.md is present — this is your first conversation. Follow its instructions.\n\n" +
        bootstrapContent,
    );

    if (options?.onboardingContext) {
      const n = normalizeOnboardingContext(options.onboardingContext);
      const lines: string[] = [
        "## First-Run User Context",
        "",
        "The user completed setup before this conversation.",
        "",
        "Known context:",
      ];
      if (n.preferredName) lines.push(`- Name: ${n.preferredName}`);
      if (n.commonWork.length)
        lines.push(`- Common work: ${n.commonWork.join("; ")}`);
      if (n.dailyTools.length)
        lines.push(`- Daily tools: ${n.dailyTools.join(", ")}`);
      if (n.assistantName)
        lines.push(`- Chosen assistant name: ${n.assistantName}`);
      if (n.tone) lines.push(`- Preferred initial voice: ${n.tone}`);
      if (n.cohort) lines.push(`- Cohort: ${n.cohort}`);
      if (n.websiteUrl) lines.push(`- Website URL: ${n.websiteUrl}`);
      if (n.contentSourceUrl)
        lines.push(`- Content source URL: ${n.contentSourceUrl}`);
      if (n.googleConnected && n.googleServices?.length) {
        lines.push(
          `- Google connected: yes (${n.googleServices.join(", ")} access granted)`,
        );
      }
      if (n.priorAssistants?.length)
        lines.push(
          `- Prior AI assistants used: ${n.priorAssistants.join(", ")}`,
        );
      lines.push(
        "",
        "Apply this context quietly. Do not recap it as a list unless the user asks.",
      );
      systemParts.push(lines.join("\n"));
    }
  }
  // Configuration section removed — workspace files are self-describing,
  // tool routing lives in tool descriptions.
  // External Communications Identity removed — guidance lives in messaging
  // and phone-calls skill SKILL.md files.
  const integrationSection = buildIntegrationSection();
  if (integrationSection) systemParts.push(integrationSection);

  // Journal entries are extracted into graph nodes by the memory pipeline.
  // Journal files remain writable on disk.

  return (
    systemParts.slice(0, dynamicStart).join("\n\n") +
    SYSTEM_PROMPT_CACHE_BOUNDARY +
    systemParts.slice(dynamicStart).join("\n\n")
  );
}

function buildIntegrationSection(): string {
  const entries: { provider: string; accountInfo?: string | null }[] = [];

  // Local (BYO) connections from the SQLite store.
  try {
    const local = listConnections().filter((c) => c.status === "active");
    entries.push(...local);
  } catch {
    // DB not available — skip local connections
  }

  // Platform-managed connections from the in-memory cache (populated at
  // daemon startup and refreshed periodically).
  const managed = getCachedManagedConnections();
  for (const mc of managed) {
    // Provider-level dedup is intentional: this section is a summary of
    // connected services for the system prompt, not an exhaustive account
    // list. Multiple accounts for the same provider (e.g. two Google
    // accounts) collapse into a single line to keep the prompt compact.
    if (!entries.some((e) => e.provider === mc.provider)) {
      entries.push(mc);
    }
  }

  if (entries.length === 0) return "";

  const lines = ["# Connected Services", ""];
  for (const conn of entries) {
    const state = conn.accountInfo
      ? `Connected (${conn.accountInfo})`
      : "Connected";
    lines.push(`- **${conn.provider}**: ${state}`);
  }

  return lines.join("\n");
}

// Re-export from shared util so existing importers don't break.
export { stripCommentLines } from "../util/strip-comment-lines.js";

export function readPromptFile(path: string): string | null {
  if (!existsSync(path)) return null;

  try {
    const content = stripCommentLines(readFileSync(path, "utf-8"));
    if (content.length === 0) return null;
    log.debug({ path }, "Loaded prompt file");
    return content;
  } catch (err) {
    log.warn({ err, path }, "Failed to read prompt file");
    return null;
  }
}

/**
 * Reads the core identity/personality prompt files (SOUL.md, IDENTITY.md)
 * and concatenates whichever exist, plus the guardian's user persona when
 * one is resolvable. Returns null if none are present.
 *
 * Used by subsystems (memory extraction, conversation starters,
 * notification decisions) that run outside the per-turn pipeline and want
 * the assistant's "view of themselves and their guardian" without a trust
 * context. The guardian persona fold is what callers used to do manually
 * by passing `userPersona: resolveGuardianPersona()` — folding it in here
 * removes the duplicated dance at every call site.
 */
export function buildCoreIdentityContext(): string | null {
  const parts: string[] = [];
  for (const file of PROMPT_FILES) {
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) continue;
    // SOUL.md is always included — it provides personality defaults even
    // before onboarding completes.  Only skip IDENTITY.md when it is still
    // an unmodified template (matching buildSystemPrompt).
    if (file !== "SOUL.md" && isTemplateContent(content, file)) continue;
    parts.push(content);
  }
  const guardianPersona = resolveGuardianPersona();
  if (guardianPersona) parts.push(guardianPersona);
  return parts.length > 0 ? parts.join("\n\n") : null;
}
