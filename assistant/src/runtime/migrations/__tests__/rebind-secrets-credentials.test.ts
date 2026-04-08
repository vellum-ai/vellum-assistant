/**
 * Tests for credential-aware rebind-secrets screen behavior.
 *
 * Covers:
 * - All credentials imported successfully -> re-enter-secrets auto-completed
 * - Partial import failure -> targeted list of failed credentials
 * - Legacy bundles without credentials -> original rebind-secrets behavior
 */

import { describe, expect, test } from "bun:test";

import type { MigrationWizardState } from "../migration-wizard.js";
import { createWizardState } from "../migration-wizard.js";
import {
  createTaskCompletionState,
  deriveRebindSecretsScreenState,
} from "../rebind-secrets-screen.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a wizard state that has progressed to the rebind-secrets step.
 */
function wizardAtRebindSecrets(
  credentialsImported?: MigrationWizardState["credentialsImported"],
): MigrationWizardState {
  const base = createWizardState();
  return {
    ...base,
    currentStep: "rebind-secrets",
    direction: "managed-to-self-hosted",
    steps: {
      ...base.steps,
      "select-direction": { status: "success" },
      "upload-bundle": { status: "success" },
      validate: { status: "success" },
      "preflight-review": { status: "success" },
      transfer: { status: "success" },
      "rebind-secrets": { status: "idle" },
      complete: { status: "idle" },
    },
    hasBundleData: true,
    credentialsImported,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rebind-secrets-screen credential awareness", () => {
  test("all credentials imported successfully -> re-enter-secrets is auto-completed", () => {
    const wizard = wizardAtRebindSecrets({
      total: 3,
      succeeded: 3,
      failed: 0,
      failedAccounts: [],
    });
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizard, completion);

    expect(screen.phase).toBe("active");
    if (screen.phase !== "active") return;

    const secretsTask = screen.tasks.find((t) => t.id === "re-enter-secrets");
    expect(secretsTask).toBeDefined();
    expect(secretsTask!.status).toBe("complete");
    expect(secretsTask!.title).toBe("API keys and secrets transferred");
    expect(secretsTask!.description).toContain("3 credential(s)");
    expect(secretsTask!.description).toContain("automatically imported");
  });

  test("partial import failure -> shows only failed credentials", () => {
    const wizard = wizardAtRebindSecrets({
      total: 3,
      succeeded: 2,
      failed: 1,
      failedAccounts: ["openai-key"],
    });
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizard, completion);

    expect(screen.phase).toBe("active");
    if (screen.phase !== "active") return;

    const secretsTask = screen.tasks.find((t) => t.id === "re-enter-secrets");
    expect(secretsTask).toBeDefined();
    expect(secretsTask!.status).toBe("pending");
    expect(secretsTask!.title).toBe("Re-enter failed credentials");
    expect(secretsTask!.description).toContain("2 of 3");
    expect(secretsTask!.description).toContain('"openai-key"');
    expect(secretsTask!.description).toContain("manual re-entry");
  });

  test("legacy bundle without credentials -> original rebind-secrets behavior", () => {
    const wizard = wizardAtRebindSecrets(undefined);
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizard, completion);

    expect(screen.phase).toBe("active");
    if (screen.phase !== "active") return;

    const secretsTask = screen.tasks.find((t) => t.id === "re-enter-secrets");
    expect(secretsTask).toBeDefined();
    expect(secretsTask!.status).toBe("pending");
    expect(secretsTask!.title).toBe("Re-enter API keys and secrets");
    expect(secretsTask!.description).toContain("redacted in export bundles");
  });

  test("all credentials imported -> allRequiredComplete reflects auto-completion", () => {
    const wizard = wizardAtRebindSecrets({
      total: 2,
      succeeded: 2,
      failed: 0,
      failedAccounts: [],
    });
    // Mark all other required tasks as complete
    let completion = createTaskCompletionState();
    completion = {
      ...completion,
      "rebind-channels": true,
      "reconfigure-auth": true,
    };
    const screen = deriveRebindSecretsScreenState(wizard, completion);

    expect(screen.phase).toBe("active");
    if (screen.phase !== "active") return;

    // re-enter-secrets is auto-completed, rebind-channels and reconfigure-auth are manually done
    expect(screen.allRequiredComplete).toBe(true);
  });

  test("partial failure -> allRequiredComplete is false when failed creds not manually acknowledged", () => {
    const wizard = wizardAtRebindSecrets({
      total: 3,
      succeeded: 2,
      failed: 1,
      failedAccounts: ["anthropic-key"],
    });
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizard, completion);

    expect(screen.phase).toBe("active");
    if (screen.phase !== "active") return;

    // re-enter-secrets is still pending (partial failure), so not all required complete
    expect(screen.allRequiredComplete).toBe(false);
  });

  test("multiple failed credentials are listed in description", () => {
    const wizard = wizardAtRebindSecrets({
      total: 4,
      succeeded: 1,
      failed: 3,
      failedAccounts: ["openai-key", "anthropic-key", "github-token"],
    });
    const completion = createTaskCompletionState();
    const screen = deriveRebindSecretsScreenState(wizard, completion);

    expect(screen.phase).toBe("active");
    if (screen.phase !== "active") return;

    const secretsTask = screen.tasks.find((t) => t.id === "re-enter-secrets");
    expect(secretsTask).toBeDefined();
    expect(secretsTask!.description).toContain('"openai-key"');
    expect(secretsTask!.description).toContain('"anthropic-key"');
    expect(secretsTask!.description).toContain('"github-token"');
    expect(secretsTask!.description).toContain("1 of 4");
  });
});
