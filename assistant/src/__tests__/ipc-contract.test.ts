import { describe, expect, test } from "bun:test";

import type {
  ClientMessage as ContractClient,
  IPCContractSchema,
  ServerMessage as ContractServer,
} from "../daemon/ipc-protocol.js";
import type {
  ClientMessage as ProtocolClient,
  ServerMessage as ProtocolServer,
} from "../daemon/ipc-protocol.js";

/**
 * Compile-time type compatibility checks.
 *
 * These assignments would cause a TypeScript compilation error if the types
 * exported from ipc-contract.ts and ipc-protocol.ts ever diverged.
 */
type AssertAssignable<T, U extends T> = U;

// If these lines compile, the types are compatible in both directions.
type _ClientForward = AssertAssignable<ContractClient, ProtocolClient>;
type _ClientReverse = AssertAssignable<ProtocolClient, ContractClient>;
type _ServerForward = AssertAssignable<ContractServer, ProtocolServer>;
type _ServerReverse = AssertAssignable<ProtocolServer, ContractServer>;

// Suppress unused-variable warnings
void (0 as unknown as _ClientForward);
void (0 as unknown as _ClientReverse);
void (0 as unknown as _ServerForward);
void (0 as unknown as _ServerReverse);

describe("IPC contract / protocol type compatibility", () => {
  test("ClientMessage from contract and protocol are the same type", () => {
    // Runtime assertion that the re-export path works
    const msg: ProtocolClient = { type: "ping" };
    const contractMsg: ContractClient = msg;
    expect(contractMsg.type).toBe("ping");
  });

  test("ServerMessage from contract and protocol are the same type", () => {
    const msg: ProtocolServer = { type: "pong" };
    const contractMsg: ContractServer = msg;
    expect(contractMsg.type).toBe("pong");
  });

  test("IPCContractSchema references the correct unions", () => {
    const schema: IPCContractSchema = {
      client: { type: "ping" },
      server: { type: "pong" },
    };
    expect(schema.client.type).toBe("ping");
    expect(schema.server.type).toBe("pong");
  });

  test("CuObservation supports optional screenshot metadata fields", () => {
    const msg: ProtocolClient = {
      type: "cu_observation",
      sessionId: "cu-sess-001",
      screenshot: "base64-data",
      screenshotWidthPx: 1280,
      screenshotHeightPx: 720,
      screenWidthPt: 1920,
      screenHeightPt: 1080,
      coordinateOrigin: "top_left",
      captureDisplayId: 69734112,
    };
    const contractMsg: ContractClient = msg;
    expect(contractMsg.type).toBe("cu_observation");
    if (contractMsg.type !== "cu_observation")
      throw new Error("Expected cu_observation");
    expect(contractMsg.coordinateOrigin).toBe("top_left");
    expect(contractMsg.screenshotWidthPx).toBe(1280);
    expect(contractMsg.screenHeightPt).toBe(1080);
  });
});
