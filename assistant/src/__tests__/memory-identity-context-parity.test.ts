/**
 * Locks the memory plugin's identity block (`buildIdentityContext`) to the
 * host's out-of-band identity block (`buildCoreIdentityContext`): same
 * prompt files, same template-skip, same guardian-persona fold, same output.
 *
 * The plugin owns its composition, so the two are allowed to diverge — but
 * only deliberately. If memory's composition changes on purpose, update or
 * drop the corresponding cases here.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports from mocked modules) ──────────────────

// Both composers fold in resolveGuardianPersona; stub it so the parity cases
// control the persona without needing a contacts fixture. Spread-real keeps
// the module's other exports intact for transitive importers.
let personaValue: string | null = null;
const realPersonaResolver = await import("../prompts/persona-resolver.js");
mock.module("../prompts/persona-resolver.js", () => ({
  ...realPersonaResolver,
  resolveGuardianPersona: () => personaValue,
}));

const { buildCoreIdentityContext } =
  await import("../prompts/system-prompt.js");
const { buildIdentityContext } =
  await import("../plugins/defaults/memory/identity-context.js");

// ── Workspace fixtures ─────────────────────────────────────────────────

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const identityPath = join(workspaceDir, "IDENTITY.md");
const soulPath = join(workspaceDir, "SOUL.md");
const templatesDir = join(import.meta.dirname, "../prompts/templates");

function resetFixtures(): void {
  rmSync(identityPath, { force: true });
  rmSync(soulPath, { force: true });
  personaValue = null;
}

/** Assert plugin output === host output, and return it for content checks. */
function expectParity(): string | null {
  const host = buildCoreIdentityContext();
  expect(buildIdentityContext()).toBe(host);
  return host;
}

describe("memory identity-context parity", () => {
  beforeEach(resetFixtures);
  afterEach(resetFixtures);

  test("no prompt files and no persona → both null", () => {
    expect(expectParity()).toBeNull();
  });

  test("customized IDENTITY.md + SOUL.md concatenate in file order", () => {
    writeFileSync(identityPath, "# Identity\n\nI am the workspace assistant.");
    writeFileSync(soulPath, "# Soul\n\nWarm, direct, curious.");
    const output = expectParity();
    expect(output).toBe(
      "# Identity\n\nI am the workspace assistant.\n\n# Soul\n\nWarm, direct, curious.",
    );
  });

  test("unmodified IDENTITY.md template is skipped; SOUL.md still counts", () => {
    const identityTemplate = readFileSync(
      join(templatesDir, "IDENTITY.md"),
      "utf-8",
    );
    writeFileSync(identityPath, identityTemplate);
    writeFileSync(soulPath, "# Soul\n\nWarm, direct, curious.");
    const output = expectParity();
    expect(output).toBe("# Soul\n\nWarm, direct, curious.");
  });

  test("SOUL.md is included even when it matches its shipped template", () => {
    const soulTemplatePath = join(templatesDir, "SOUL.md");
    if (!existsSync(soulTemplatePath)) {
      return;
    } // no shipped SOUL template
    writeFileSync(soulPath, readFileSync(soulTemplatePath, "utf-8"));
    const output = expectParity();
    expect(output).not.toBeNull();
  });

  test("guardian persona is appended last", () => {
    writeFileSync(identityPath, "# Identity\n\nI am the workspace assistant.");
    personaValue = "## User\n\nAlice (she/her), prefers terse updates.";
    const output = expectParity();
    expect(output).toBe(
      "# Identity\n\nI am the workspace assistant.\n\n## User\n\nAlice (she/her), prefers terse updates.",
    );
  });

  test("persona alone still produces a block", () => {
    personaValue = "## User\n\nAlice (she/her).";
    expect(expectParity()).toBe("## User\n\nAlice (she/her).");
  });
});
