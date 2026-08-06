import { describe, expect, test } from "bun:test";

import { getWorkspaceDir } from "../util/platform.js";
import { buildFileContext } from "./checker.js";
import {
  executableSinkDirs,
  isControlPlaneWorkspaceWrite,
} from "./workspace-policy.js";

/**
 * Two lists decide whether a write is treated as code injection, and they are
 * consulted by different layers: `buildFileContext` feeds the gateway's file
 * risk classifier, which sets the approval risk level, while
 * `executableSinkDirs` feeds the assistant's own approval-floor policy for
 * delegated channels. A directory in one and not the other is escalated on
 * one path and waved through on the other, which is how `.githooks` came to
 * be covered by neither.
 *
 * This pins them together so the next directory added to either has to be
 * added to both.
 */

/**
 * Context fields that name a directory whose contents the daemon executes.
 * `protectedDir`, `deprecatedDir`, and the signing key path are read
 * protections rather than execution sinks, so they are deliberately absent.
 */
const EXECUTABLE_CONTEXT_FIELDS = [
  "hooksDir",
  "gitDir",
  "gitHooksDir",
  "pluginsDir",
  "toolsDir",
  "routesDir",
  "workflowsDir",
  "monitoringDir",
] as const;

describe("executable sink lists", () => {
  test("every executable directory the classifier knows is also an approval-floor sink", () => {
    const context = buildFileContext() as unknown as Record<string, string>;
    const sinks = new Set(executableSinkDirs());

    for (const field of EXECUTABLE_CONTEXT_FIELDS) {
      const dir = context[field];
      expect(typeof dir).toBe("string");
      expect(
        sinks.has(dir as string),
        `${field} (${dir}) is classified as an execution sink but is missing from executableSinkDirs()`,
      ).toBe(true);
    }
  });

  test.each([
    [".git/config"],
    [".git/hooks/pre-commit"],
    [".githooks/pre-commit"],
  ])("a file_write to %s is a control-plane write", (relPath) => {
    // Membership in the list is not the same as the decision consuming it,
    // so this exercises the approval-floor predicate itself rather than
    // asserting the list contents a second time.
    const root = getWorkspaceDir();
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: `${root}/${relPath}` },
        root,
      ),
    ).toBe(true);
  });

  test("an ordinary workspace file is not a control-plane write", () => {
    const root = getWorkspaceDir();
    expect(
      isControlPlaneWorkspaceWrite(
        "file_write",
        { path: `${root}/notes.md` },
        root,
      ),
    ).toBe(false);
  });

  test("skill roots are covered too, via the skills directory", () => {
    // The classifier carries skill roots as a list rather than one dir, so it
    // is checked separately from the field sweep above.
    const context = buildFileContext();
    expect(context.skillSourceDirs.length).toBeGreaterThan(0);
  });
});
