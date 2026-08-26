/**
 * Tests for `gateway contacts`. Parse and execute against a stub IPC
 * caller so the suite does not need a live gateway socket.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  executeContactsCommand,
  parseContactsArgs,
  type GatewayIpcCall,
} from "../contacts.js";

let lastIpc: { method: string; params?: Record<string, unknown> } | null =
  null;
let ipcResult: unknown = { ok: true, contacts: [] };

const ipc: GatewayIpcCall = async (method, params) => {
  lastIpc = { method, params };
  return ipcResult;
};

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  };
  try {
    const parsed = parseContactsArgs(args);
    const code = await executeContactsCommand(parsed, ipc);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

beforeEach(() => {
  lastIpc = null;
  ipcResult = { ok: true, contacts: [] };
});

describe("parseContactsArgs", () => {
  test("maps inherit to a null ceiling", () => {
    expect(
      parseContactsArgs([
        "set-risk-threshold",
        "contact-1",
        "--threshold",
        "inherit",
      ]),
    ).toEqual({
      kind: "set-risk-threshold",
      contactId: "contact-1",
      threshold: null,
      json: false,
    });
  });

  test("rejects an unknown threshold without calling IPC", () => {
    expect(
      parseContactsArgs([
        "set-risk-threshold",
        "contact-1",
        "--threshold",
        "full",
      ]),
    ).toEqual({
      kind: "error",
      message:
        'Invalid --threshold "full". Must be one of: none, low, medium, high, inherit.',
    });
  });
});

describe("gateway contacts set-risk-threshold", () => {
  test("writes a ceiling over IPC", async () => {
    ipcResult = { ok: true, contactId: "contact-1", threshold: "high" };
    const { code, stdout } = await run([
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "high",
    ]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "set_contact_threshold",
      params: { contactId: "contact-1", threshold: "high" },
    });
    expect(stdout).toContain("Set assistant access for contact-1 to high");
  });

  test("maps inherit to a null ceiling", async () => {
    ipcResult = { ok: true, contactId: "contact-1", threshold: null };
    const { code, stdout } = await run([
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "inherit",
    ]);
    expect(code).toBe(0);
    expect(lastIpc?.params).toEqual({
      contactId: "contact-1",
      threshold: null,
    });
    expect(stdout).toContain("Set assistant access for contact-1 to inherit");
  });

  test("maps a missing contact to exit 1", async () => {
    ipcResult = { ok: false, error: "not_found" };
    const { code, stderr } = await run([
      "set-risk-threshold",
      "contact-missing",
      "--threshold",
      "high",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("not found");
  });

  test("exits 1 when the gateway is unreachable", async () => {
    ipcResult = undefined;
    const { code, stderr } = await run([
      "set-risk-threshold",
      "contact-1",
      "--threshold",
      "high",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("unreachable");
  });
});

describe("gateway contacts list and get", () => {
  test("lists contacts over IPC", async () => {
    ipcResult = {
      ok: true,
      contacts: [
        {
          id: "contact-1",
          displayName: "Alice",
          role: "contact",
          autoApproveThreshold: "high",
        },
      ],
    };
    const { code, stdout } = await run(["list"]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "contacts_list_rich",
      params: {},
    });
    expect(stdout).toContain("contact-1");
    expect(stdout).toContain("Alice");
    expect(stdout).toContain("access:high");
  });

  test("gets one contact over IPC", async () => {
    ipcResult = {
      ok: true,
      contact: {
        id: "contact-1",
        displayName: "Alice",
        role: "contact",
        autoApproveThreshold: null,
      },
    };
    const { code, stdout } = await run(["get", "contact-1"]);
    expect(code).toBe(0);
    expect(lastIpc).toEqual({
      method: "contacts_get_rich",
      params: { contactId: "contact-1" },
    });
    expect(stdout).toContain("Access:       inherit");
  });
});
