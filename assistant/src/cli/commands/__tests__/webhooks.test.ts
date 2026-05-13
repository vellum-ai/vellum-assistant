import { beforeEach, describe, expect, it, mock } from "bun:test";

import { Command } from "commander";

let mockCalls: Array<[string, Record<string, unknown>]> = [];
let mockResponse: unknown = {
  ok: true,
  result: {
    callbackUrl: "https://example.com/webhooks/telegram",
    type: "telegram",
    path: "webhooks/telegram",
    mode: "platform",
  },
};

mock.module("../../../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params: Record<string, unknown>) => {
    mockCalls.push([method, params]);
    return mockResponse;
  },
  exitFromIpcResult: (_r: unknown, _cmd: unknown) => {
    throw new Error("exitFromIpcResult called");
  },
}));

const { registerWebhooksCommand } = await import("../webhooks.js");

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerWebhooksCommand(program);
  return program;
}

describe("webhooks register", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = {
      ok: true,
      result: {
        callbackUrl: "https://example.com/webhooks/telegram",
        type: "telegram",
        path: "webhooks/telegram",
        mode: "platform",
      },
    };
  });

  it("calls webhooks_register with type", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", "webhooks", "register", "telegram"]);
    expect(mockCalls.length).toBe(1);
    expect(mockCalls[0][0]).toBe("webhooks_register");
    expect((mockCalls[0][1].body as Record<string, unknown>).type).toBe("telegram");
  });

  it("passes path override", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "webhooks",
      "register",
      "twilio_voice",
      "--path",
      "webhooks/twilio/voice",
    ]);
    expect((mockCalls[0][1].body as Record<string, unknown>).path).toBe("webhooks/twilio/voice");
  });

  it("passes source label", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "assistant",
      "webhooks",
      "register",
      "resend",
      "--source",
      "@bot",
    ]);
    expect((mockCalls[0][1].body as Record<string, unknown>).source).toBe("@bot");
  });

  it("calls exitFromIpcResult on error", async () => {
    mockResponse = { ok: false, error: "not configured", statusCode: 422 };
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "assistant", "webhooks", "register", "telegram"]),
    ).rejects.toThrow("exitFromIpcResult called");
  });
});

describe("webhooks list", () => {
  beforeEach(() => {
    mockCalls = [];
    mockResponse = { ok: true, result: { routes: [] } };
  });

  it("calls webhooks_list with no params", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "assistant", "webhooks", "list"]);
    expect(mockCalls.length).toBe(1);
    expect(mockCalls[0][0]).toBe("webhooks_list");
  });

  it("calls exitFromIpcResult on error", async () => {
    mockResponse = { ok: false, error: "daemon down", statusCode: undefined };
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "assistant", "webhooks", "list"]),
    ).rejects.toThrow("exitFromIpcResult called");
  });
});
