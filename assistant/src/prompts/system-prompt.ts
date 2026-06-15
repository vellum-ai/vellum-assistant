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
import type { ChannelCapabilities } from "../daemon/conversation-runtime-assembly.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { markActivationSession } from "../memory/activation-session-store.js";
import { ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE } from "../telemetry/activation-funnel.js";
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
import { resolveGuardianPersona, resolveUserSlug } from "./persona-resolver.js";
import { renderWorkspaceSections } from "./sections.js";
import { isTemplateContent } from "./template-detection.js";

export { isTemplateContent };

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
 * template AND a matching template file exists in the bundled templates dir,
 * overwrite the workspace file with the specified variant.  No-op when
 * BOOTSTRAP.md has been deleted, modified, or the template file is missing.
 */
export function maybeReseedBootstrap(templateFileName: string): boolean {
  // Path traversal guard: reject filenames containing directory separators or
  // parent-directory references, and require a `.md` extension.
  if (
    templateFileName.includes("/") ||
    templateFileName.includes("..") ||
    !templateFileName.endsWith(".md")
  ) {
    log.warn(
      { templateFileName },
      "Rejected bootstrap template filename: invalid characters or extension",
    );
    return false;
  }

  const bootstrapPath = getWorkspacePromptPath("BOOTSTRAP.md");
  if (!existsSync(bootstrapPath)) return false;

  const currentContent = readPromptFile(bootstrapPath);
  // Compare against the GENERIC "BOOTSTRAP.md" template, not the specified
  // one.  After the swap, the workspace content no longer matches the generic
  // template, so this guard returns false on subsequent calls — making the
  // swap idempotent.  Do NOT change the comparison target to the provided
  // template filename; that would re-swap on every prompt build.
  if (!isTemplateContent(currentContent, "BOOTSTRAP.md")) return false;

  const templatesDir = resolveBundledDir(
    import.meta.dirname ?? __dirname,
    "templates",
    "templates",
  );
  const templatePath = join(templatesDir, templateFileName);
  if (!existsSync(templatePath)) {
    log.warn(
      { templateFileName },
      "Bootstrap template not found, keeping generic BOOTSTRAP.md",
    );
    return false;
  }

  try {
    const templateContent = readFileSync(templatePath, "utf-8");
    writeFileSync(bootstrapPath, templateContent, "utf-8");
    log.info(
      { templateFileName },
      "Replaced generic BOOTSTRAP.md with specified template",
    );
    return true;
  } catch (err) {
    log.warn(
      { err, templateFileName },
      "Failed to reseed BOOTSTRAP.md with template",
    );
    return false;
  }
}

/**
 * Reseed BOOTSTRAP.md from the requested onboarding template (one-shot,
 * idempotent) and, when that template is the activation rail AND the rail is
 * now the active bootstrap, mark the conversation as an activation session.
 *
 * Marking happens here — at the single point where the bootstrap selection is
 * known — so it lands BEFORE the agent loop resolves tools and BEFORE the model
 * can call the emit tool on the first activation-rail turn. (`resolveTools`
 * runs before `resolveSystemPrompt` in the loop, so the system-prompt build is
 * too late to be the *only* marking site.) The marker write is best-effort and
 * idempotent (`markActivationSession` swallows errors and dedups on the PK), so
 * calling this from both `setOnboardingContext` and `buildSystemPrompt` is safe.
 *
 * The activation mark is gated on the rail actually being the active bootstrap —
 * either this call just installed it, OR BOOTSTRAP.md already holds the
 * activation-rail template. When the reseed no-ops because BOOTSTRAP.md is
 * missing or customized to something else, the rail is NOT active, so we must
 * NOT mark (otherwise non-rail conversations would pollute activation
 * telemetry).
 */
export function applyBootstrapTemplate(
  bootstrapTemplate: string,
  conversationId?: string,
): void {
  const installedActivationRail = maybeReseedBootstrap(bootstrapTemplate);
  if (
    bootstrapTemplate === ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE &&
    conversationId &&
    (installedActivationRail ||
      isTemplateContent(
        readPromptFile(getWorkspacePromptPath("BOOTSTRAP.md")),
        ACTIVATION_RAIL_BOOTSTRAP_TEMPLATE,
      ))
  ) {
    markActivationSession(conversationId);
  }
}

/**
 * Explicit prompt-build override for builds that run outside the
 * inbound-turn pipeline (agent wakes). Each field, when present, takes
 * precedence over the corresponding derivation in {@link buildSystemPrompt}.
 * Prompt-build selection only — trust class and approval semantics are
 * unaffected.
 */
export interface SystemPromptPersonaOverride {
  /** Renders `users/<slug>.md` as the user persona section. */
  userSlug?: string;
  /** Renders `channels/<slug>.md` as the channel persona section. */
  channelSlug?: string;
  /**
   * Pins the `hasNoClient` flag for the prompt build, taking precedence over
   * the top-level `BuildSystemPromptOptions.hasNoClient` (which mirrors the
   * conversation's live client state). The `05-access-preference` section
   * renders different text under the flag — early in the prompt, so a
   * mismatch breaks byte-parity with a cached prefix even when persona and
   * profile match. Used by fork-based memory retrospectives: the fork is
   * hydrated clientless (`hasNoClient = true`) while the source's live turns
   * ran under the source's own client state (`false` for interactive
   * interfaces, `true` for channel-routed sources) — the pin carries that
   * live-turn value.
   */
  hasNoClient?: boolean;
}

export interface BuildSystemPromptOptions {
  hasNoClient?: boolean;
  excludeBootstrap?: boolean;
  excludeCustomPrefix?: boolean;
  trustContext?: TrustContext;
  channelCapabilities?: ChannelCapabilities;
  onboardingContext?: OnboardingContext;
  /**
   * Explicit persona/channel slugs, taking precedence over the
   * trust-context-derived `userSlug` and capabilities-derived `channelSlug`.
   * Used by fork-based memory retrospectives so the fork's prompt renders the
   * SOURCE conversation's persona sections (review quality + byte-parity with
   * the source's cached system-prompt prefix) even though the wake itself
   * carries an internal guardian trust context with no requester identity.
   */
  personaOverride?: SystemPromptPersonaOverride;
  /**
   * Conversation this prompt is being built for. Optional because several
   * callers build a prompt outside a conversation (e.g. home greeting,
   * suggested prompts). When present and the activation-rail bootstrap template
   * is selected, the conversation is marked as an activation session.
   */
  conversationId?: string;
}

/**
 * Build the system prompt by rendering `BUNDLED_SYSTEM_SECTIONS` (with
 * workspace overrides per section).  Per-section behaviour lives in
 * `system-sections.ts`; the renderer in `sections.ts` handles
 * frontmatter `enabled:` predicates, `{{variable}}` interpolation,
 * file-backed bodies, and runtime-computed transforms.
 */
export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  // One-shot bootstrap reseed + activation-rail marking. The marking also runs
  // earlier, at `setOnboardingContext`, so the activation session is recorded
  // before the agent loop resolves tools on the first turn; this call is a
  // harmless idempotent backstop for prompt builds outside that path.
  const bootstrapTemplate = options?.onboardingContext?.bootstrapTemplate;
  if (bootstrapTemplate) {
    applyBootstrapTemplate(bootstrapTemplate, options?.conversationId);
  }

  // Slugs used by the persona sections (`10-user-persona`,
  // `11-channel-persona`) and the BOOTSTRAP block.  `userSlug` is the
  // raw slug derived from the caller's trust context (falling back to
  // the guardian's contact, then to "default" when nothing resolves);
  // `users/<slug>.md → users/default.md` fallback lives in the
  // section's `workspacePath` array.  `channelSlug` is the channel
  // identifier from `channelCapabilities`, defaulting to "vellum".
  // An explicit `personaOverride` slug wins over either derivation.
  const userSlug =
    options?.personaOverride?.userSlug ??
    resolveUserSlug(options?.trustContext) ??
    "default";
  const channelSlug =
    options?.personaOverride?.channelSlug ??
    options?.channelCapabilities?.channel ??
    "vellum";
  // The override's `hasNoClient` pin wins over the conversation-derived
  // top-level option (see the interface doc); placed after the `...options`
  // spread below so it overrides the spread-in value.
  const hasNoClient =
    options?.personaOverride?.hasNoClient ?? options?.hasNoClient;

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
    hasNoClient,
    isContainerized: getIsContainerized(),
    workspaceDir: getWorkspaceDir(),
    userSlug,
    channelSlug,
  };

  // Every system-prompt block flows through the bundled section
  // pipeline — including runtime-computed entries like
  // `14-connected-services` whose body is derived from live OAuth
  // caches.  Sections render grouped into cache blocks (split at the
  // section carrying a cache-breakpoint declaration — by default
  // `11-channel-persona`); the blocks are joined with the
  // `SYSTEM_PROMPT_CACHE_BOUNDARY` marker, which the Anthropic provider
  // splits into independently cached system blocks and other providers
  // strip.  Empty blocks are dropped so the marker never dangles at
  // either end of the prompt.
  return renderWorkspaceSections(ctx)
    .map((block) => block.join("\n\n"))
    .filter((block) => block.length > 0)
    .join(SYSTEM_PROMPT_CACHE_BOUNDARY);
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
