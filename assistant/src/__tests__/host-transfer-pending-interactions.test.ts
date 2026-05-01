/**
 * Unit tests for host_transfer message types and pending interaction
 * registration.
 *
 * Verifies:
 * - HostTransferRequest and HostTransferCancelRequest are part of ServerMessage
 * - "host_transfer" is a valid PendingInteraction kind
 * - host_transfer interactions survive removeByConversation (not auto-denied)
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type {
  HostTransferCancelRequest,
  HostTransferRequest,
  HostTransferToHostRequest,
  HostTransferToSandboxRequest,
  ServerMessage,
} from "../daemon/message-protocol.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

// ---------------------------------------------------------------------------
// Message type compilation checks
// ---------------------------------------------------------------------------

describe("HostTransfer message types", () => {
  test("HostTransferToHostRequest is assignable to ServerMessage", () => {
    const msg: HostTransferToHostRequest = {
      type: "host_transfer_request",
      requestId: "req-1",
      conversationId: "conv-1",
      direction: "to_host",
      transferId: "xfer-1",
      destPath: "/tmp/file.txt",
      sizeBytes: 1024,
      sha256: "abc123",
      overwrite: false,
    };
    const _sm: ServerMessage = msg;
    expect(_sm.type).toBe("host_transfer_request");
  });

  test("HostTransferToSandboxRequest is assignable to ServerMessage", () => {
    const msg: HostTransferToSandboxRequest = {
      type: "host_transfer_request",
      requestId: "req-2",
      conversationId: "conv-1",
      direction: "to_sandbox",
      transferId: "xfer-2",
      sourcePath: "/home/user/file.txt",
    };
    const _sm: ServerMessage = msg;
    expect(_sm.type).toBe("host_transfer_request");
  });

  test("HostTransferCancelRequest is assignable to ServerMessage", () => {
    const msg: HostTransferCancelRequest = {
      type: "host_transfer_cancel",
      requestId: "req-3",
      conversationId: "conv-1",
    };
    const _sm: ServerMessage = msg;
    expect(_sm.type).toBe("host_transfer_cancel");
  });

  test("HostTransferRequest union covers both directions", () => {
    const toHost: HostTransferRequest = {
      type: "host_transfer_request",
      requestId: "req-4",
      conversationId: "conv-1",
      direction: "to_host",
      transferId: "xfer-3",
      destPath: "/tmp/out.bin",
      sizeBytes: 512,
      sha256: "def456",
      overwrite: true,
    };
    const toSandbox: HostTransferRequest = {
      type: "host_transfer_request",
      requestId: "req-5",
      conversationId: "conv-1",
      direction: "to_sandbox",
      transferId: "xfer-4",
      sourcePath: "/data/input.csv",
    };
    expect(toHost.direction).toBe("to_host");
    expect(toSandbox.direction).toBe("to_sandbox");
  });
});

// ---------------------------------------------------------------------------
// Pending interaction registration
// ---------------------------------------------------------------------------

describe("host_transfer pending interactions", () => {
  beforeEach(() => {
    pendingInteractions.clear();
  });

  test("host_transfer can be registered as a pending interaction", () => {
    pendingInteractions.register("req-1", {
      conversationId: "conv-1",
      kind: "host_transfer",
    });

    const interaction = pendingInteractions.get("req-1");
    expect(interaction).toBeDefined();
    expect(interaction!.kind).toBe("host_transfer");
    expect(interaction!.conversationId).toBe("conv-1");
  });

  test("host_transfer interactions survive removeByConversation", () => {
    // Register a confirmation (should be removed) and a host_transfer (should survive)
    pendingInteractions.register("confirm-1", {
      conversationId: "conv-1",
      kind: "confirmation",
    });
    pendingInteractions.register("transfer-1", {
      conversationId: "conv-1",
      kind: "host_transfer",
    });

    pendingInteractions.removeByConversation("conv-1");

    // Confirmation should be gone
    expect(pendingInteractions.get("confirm-1")).toBeUndefined();
    // host_transfer should survive
    expect(pendingInteractions.get("transfer-1")).toBeDefined();
    expect(pendingInteractions.get("transfer-1")!.kind).toBe("host_transfer");
  });

  test("host_transfer interactions can be resolved", () => {
    pendingInteractions.register("req-1", {
      conversationId: "conv-1",
      kind: "host_transfer",
    });

    const resolved = pendingInteractions.resolve("req-1");
    expect(resolved).toBeDefined();
    expect(resolved!.kind).toBe("host_transfer");

    // After resolve, it should be gone
    expect(pendingInteractions.get("req-1")).toBeUndefined();
  });
});
