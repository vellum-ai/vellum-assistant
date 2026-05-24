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
import {
  resolveGuardianPersona,
  resolveUserSlug,
} from "./persona-resolver.js";
import { renderWorkspaceSections } from "./sections.js";
import { isTemplateContent } from "./template-detection.js";

export { isTemplateContent };

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

export interface BuildSystemPromptOptions {
  hasNoClient?: boolean;
  excludeBootstrap?: boolean;
  excludeCustomPrefix?: boolean;
  trustContext?: TrustContext;
  channelCapabilities?: ChannelCapabilities;
  onboardingContext?: OnboardingContext;
}

/**
 * Build the system prompt by rendering `BUNDLED_SYSTEM_SECTIONS` (with
 * workspace overrides per section).  Per-section behaviour lives in
 * `system-sections.ts`; the renderer in `sections.ts` handles
 * frontmatter `enabled:` predicates, `{{variable}}` interpolation,
 * file-backed bodies, and runtime-computed transforms.
 */
export function buildSystemPrompt(options?: BuildSystemPromptOptions): string {
  // One-shot cohort swap: if the user has a cohort and BOOTSTRAP.md is still
  // the generic template, replace it with the cohort-specific variant before
  // the prompt reads the file.
  if (options?.onboardingContext?.cohort) {
    maybeReseedBootstrapForCohort(options.onboardingContext.cohort);
  }

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
    userSlug,
    channelSlug,
  };

  // Every system-prompt block flows through the bundled section
  // pipeline — including runtime-computed entries like
  // `14-connected-services` whose body is derived from live OAuth
  // caches.  The whole prompt is treated as a single cached block by
  // the Anthropic provider; per-provider details live in each
  // provider's client.
  return renderWorkspaceSections(ctx).join("\n\n");
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
