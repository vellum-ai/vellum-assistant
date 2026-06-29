/**
 * Tests for the manage_secure_command_tool handler's operation serialization.
 *
 * The register path awaits a bundle download mid-handler. Without
 * serialization, a concurrent unregister could run its "still in use?" check
 * and bundle delete during that await — against a registry that doesn't yet
 * reflect the in-flight registration — transiently deleting a bundle another
 * caller is publishing or executing. The handler runs operations one-at-a-time
 * to close that window.
 */

import { describe, expect, test } from "bun:test";

import type { ManageSecureCommandTool } from "@vellumai/service-contracts/credential-rpc";

import {
  createManageSecureCommandToolHandler,
  type ManageSecureCommandToolHandlerDeps,
} from "../server.js";

const CTX = { sessionId: "test-session" };

function registerRequest(toolName: string): ManageSecureCommandTool {
  return {
    action: "register",
    toolName,
    bundleId: "bundle-1",
    version: "1.0.0",
    sourceUrl: "https://example.com/bundle.tgz",
    sha256: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef0",
    credentialHandle: "local_static:svc/key",
    description: "a tool",
    // publishBundle is mocked in these tests, so the manifest contents are
    // irrelevant — only its presence matters for the required-field check.
    secureCommandManifest: {} as unknown as ManageSecureCommandTool["secureCommandManifest"],
  };
}

function unregisterRequest(toolName: string): ManageSecureCommandTool {
  return { action: "unregister", toolName };
}

describe("manage_secure_command_tool serialization", () => {
  test("a slow register does not let a concurrent unregister interleave", async () => {
    const events: string[] = [];

    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });

    const deps: ManageSecureCommandToolHandlerDeps = {
      downloadBundle: async () => {
        events.push("download:start");
        await downloadGate;
        events.push("download:end");
        return Buffer.from("bundle-bytes");
      },
      publishBundle: () => {
        events.push("publish");
        return { success: true, deduplicated: false, bundlePath: "/tmp/bundle" };
      },
      registerTool: () => {
        events.push("register");
      },
      unregisterTool: (toolName: string) => {
        events.push(`unregister:${toolName}`);
        return true;
      },
    };

    const handler = createManageSecureCommandToolHandler(deps);

    // Fire a register (which blocks in downloadBundle) then an unregister.
    const registerPromise = handler(registerRequest("tool-a"), CTX);
    const unregisterPromise = handler(unregisterRequest("tool-b"), CTX);

    // Let the event loop run: the register has reached its download await, and
    // the unregister must be queued behind it — its delete must not have run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["download:start"]);

    // Release the download; both operations complete in order.
    releaseDownload();
    const [registerResult, unregisterResult] = await Promise.all([
      registerPromise,
      unregisterPromise,
    ]);

    expect(registerResult.success).toBe(true);
    expect(unregisterResult.success).toBe(true);

    // The unregister ran only after the register fully completed.
    expect(events).toEqual([
      "download:start",
      "download:end",
      "publish",
      "register",
      "unregister:tool-b",
    ]);
  });

  test("a rejected operation does not break serialization for later ones", async () => {
    const events: string[] = [];

    const deps: ManageSecureCommandToolHandlerDeps = {
      downloadBundle: async () => {
        throw new Error("network down");
      },
      publishBundle: () => ({
        success: true,
        deduplicated: false,
        bundlePath: "/tmp/bundle",
      }),
      registerTool: () => {},
      unregisterTool: (toolName: string) => {
        events.push(`unregister:${toolName}`);
        return true;
      },
    };

    const handler = createManageSecureCommandToolHandler(deps);

    // First op fails inside the handler (download error → structured failure),
    // second op must still run.
    const first = await handler(registerRequest("tool-a"), CTX);
    const second = await handler(unregisterRequest("tool-b"), CTX);

    expect(first.success).toBe(false);
    expect(first.error?.code).toBe("DOWNLOAD_FAILED");
    expect(second.success).toBe(true);
    expect(events).toEqual(["unregister:tool-b"]);
  });
});
