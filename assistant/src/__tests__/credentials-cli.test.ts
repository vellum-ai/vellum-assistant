import { beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

type ExecuteCall = {
  input: Record<string, unknown>;
  context: Record<string, unknown>;
};

const executeCalls: ExecuteCall[] = [];
let nextResult: { content: string; isError: boolean } = {
  content: "ok",
  isError: false,
};
const secureValues = new Map<string, string>();
const infoLogs: string[] = [];
const errorLogs: string[] = [];

mock.module("../tools/credentials/vault.js", () => ({
  credentialStoreTool: {
    execute: async (
      input: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => {
      executeCalls.push({ input, context });
      return nextResult;
    },
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => secureValues.get(key),
}));

mock.module("../oauth/provider-profiles.js", () => ({
  resolveService: (service: string) =>
    service === "gmail" ? "integration:gmail" : service,
}));

mock.module("../util/logger.js", () => ({
  getCliLogger: () => ({
    info: (message: string) => {
      infoLogs.push(String(message));
    },
    error: (message: string) => {
      errorLogs.push(String(message));
    },
  }),
}));

const { registerCredentialsCommand } = await import("../cli/credentials.js");

async function runCli(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const program = new Command();
  registerCredentialsCommand(program);

  const originalWrite = process.stdout.write.bind(process.stdout);
  const stdoutChunks: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  let exitCode = 0;
  try {
    await program.parseAsync(["node", "vellum", ...args]);
    exitCode = process.exitCode ?? 0;
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = priorExitCode;
  }

  return {
    stdout: stdoutChunks.join(""),
    exitCode,
  };
}

describe("vellum credentials CLI", () => {
  beforeEach(() => {
    executeCalls.length = 0;
    nextResult = { content: "ok", isError: false };
    secureValues.clear();
    infoLogs.length = 0;
    errorLogs.length = 0;
    process.exitCode = 0;
  });

  test("list delegates to credential_store list action", async () => {
    nextResult = { content: "[]", isError: false };

    const result = await runCli(["credentials", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.input).toEqual({ action: "list" });
  });

  test("set forwards policy options to store action", async () => {
    nextResult = {
      content: "Stored credential for twilio/auth_token.",
      isError: false,
    };

    const result = await runCli([
      "credentials",
      "set",
      "twilio",
      "auth_token",
      "secret-value",
      "--allowed-tool",
      "bash",
      "--allowed-domain",
      "api.twilio.com",
      "--usage-description",
      "Twilio auth token",
      "--alias",
      "twilio-primary",
    ]);

    expect(result.exitCode).toBe(0);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.input).toMatchObject({
      action: "store",
      service: "twilio",
      field: "auth_token",
      value: "secret-value",
      allowed_tools: ["bash"],
      allowed_domains: ["api.twilio.com"],
      usage_description: "Twilio auth token",
      alias: "twilio-primary",
    });
    expect(executeCalls[0]?.context.trustClass).toBe("guardian");
  });

  test("get prints redacted credential output", async () => {
    secureValues.set("credential:ngrok:authtoken", "token-123");

    const result = await runCli([
      "credentials",
      "get",
      "ngrok",
      "authtoken",
      "--redacted",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[REDACTED length=9]\n");
  });

  test("get resolves service aliases before reading secure keys", async () => {
    secureValues.set(
      "credential:integration:gmail:access_token",
      "oauth-token",
    );

    const result = await runCli([
      "credentials",
      "get",
      "gmail",
      "access_token",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("oauth-token\n");
    expect(infoLogs).toContain(
      "Resolved gmail/access_token to integration:gmail/access_token",
    );
  });

  test("oauth2-connect parses repeated scope and extra params", async () => {
    nextResult = { content: "Connected", isError: false };

    const result = await runCli([
      "credentials",
      "oauth2-connect",
      "gmail",
      "--scope",
      "openid",
      "--scope",
      "email",
      "--extra-param",
      "prompt=consent",
      "--extra-param",
      "access_type=offline",
    ]);

    expect(result.exitCode).toBe(0);
    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]?.input).toMatchObject({
      action: "oauth2_connect",
      service: "gmail",
      scopes: ["openid", "email"],
      extra_params: {
        prompt: "consent",
        access_type: "offline",
      },
    });
  });

  test("oauth2-connect reports invalid extra-param input", async () => {
    const result = await runCli([
      "credentials",
      "oauth2-connect",
      "gmail",
      "--extra-param",
      "invalid-value",
    ]);

    expect(result.exitCode).toBe(1);
    expect(executeCalls).toHaveLength(0);
    expect(errorLogs[0]).toContain("Invalid --extra-param");
  });
});
