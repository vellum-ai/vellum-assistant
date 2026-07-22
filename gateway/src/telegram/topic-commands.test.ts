import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { GatewayConfig } from "../config.js";

const sendTelegramReplyMock = mock(() => Promise.resolve());
const resolveTrustVerdictMock = mock(
  (): Promise<{ trustClass: string }> =>
    Promise.resolve({ trustClass: "unknown" }),
);
const forkTelegramTopicMock = mock(() => Promise.resolve());

mock.module("./send.js", () => ({
  sendTelegramReply: sendTelegramReplyMock,
}));

mock.module("../risk/trust-verdict-resolver.js", () => ({
  resolveTrustVerdict: resolveTrustVerdictMock,
}));

mock.module("../runtime/client.js", () => ({
  applyTelegramTopicTitleFromTelegram: mock(() => Promise.resolve()),
  archiveTelegramTopic: mock(() => Promise.resolve({ title: null })),
  forkTelegramTopic: forkTelegramTopicMock,
  getTelegramTopicAccessMode: mock(() =>
    Promise.resolve({ currentThreshold: "medium" }),
  ),
  listTelegramTopicProfiles: mock(() =>
    Promise.resolve({ profiles: [], currentProfile: null }),
  ),
  renameTelegramTopic: mock(() => Promise.resolve()),
  setTelegramTopicAccessMode: mock(() => Promise.resolve({})),
  setTelegramTopicProfile: mock(() => Promise.resolve({ label: "Balanced" })),
  stopTelegramTopic: mock(() => Promise.resolve({ cancelled: false })),
}));

const {
  ensureTelegramGuardianActor,
  handleTelegramForkCommand,
  handleTelegramHelpCommand,
  TELEGRAM_GUARDIAN_COMMAND_DENIED,
  parseTelegramAccessCallback,
  parseTelegramAccessCommand,
  parseTelegramArchiveCommand,
  parseTelegramForkCommand,
  parseTelegramHelpCommand,
  parseTelegramProfileCallback,
  parseTelegramProfileCommand,
  parseTelegramRenameCommand,
  parseTelegramStopCommand,
} = await import("./topic-commands.js");

const baseConfig = {} as GatewayConfig;
const logger = { error: () => {}, warn: () => {}, info: () => {} } as never;

describe("telegram topic command parsers", () => {
  it("parses /fork with optional bot mention", () => {
    expect(parseTelegramForkCommand("/fork")).toBe(true);
    expect(parseTelegramForkCommand("/fork@MyBot")).toBe(true);
    expect(parseTelegramForkCommand("/new")).toBe(false);
  });

  it("parses /rename with and without a name", () => {
    expect(parseTelegramRenameCommand("/rename")).toEqual({});
    expect(parseTelegramRenameCommand("/rename Project Alpha")).toEqual({
      name: "Project Alpha",
    });
    expect(parseTelegramRenameCommand("/new")).toBeNull();
  });

  it("parses /archive with optional bot mention", () => {
    expect(parseTelegramArchiveCommand("/archive")).toBe(true);
    expect(parseTelegramArchiveCommand("/archive@MyBot")).toBe(true);
    expect(parseTelegramArchiveCommand("/archived")).toBe(false);
    expect(parseTelegramArchiveCommand("/new")).toBe(false);
  });

  it("parses /stop with optional bot mention", () => {
    expect(parseTelegramStopCommand("/stop")).toBe(true);
    expect(parseTelegramStopCommand("/stop@MyBot")).toBe(true);
    expect(parseTelegramStopCommand("/stopped")).toBe(false);
    expect(parseTelegramStopCommand("/new")).toBe(false);
  });

  it("parses /profile, /access, and /help (with bot mention)", () => {
    expect(parseTelegramProfileCommand("/profile")).toBe(true);
    expect(parseTelegramAccessCommand("/access")).toBe(true);
    expect(parseTelegramHelpCommand("/help")).toBe(true);
    expect(parseTelegramHelpCommand("/help@MyBot")).toBe(true);
    expect(parseTelegramProfileCommand("/profiles")).toBe(false);
    expect(parseTelegramHelpCommand("/helpme")).toBe(false);
  });

  it("parses profile and access callbacks", () => {
    expect(parseTelegramProfileCallback("prf:balanced")).toEqual({
      profile: "balanced",
    });
    expect(parseTelegramAccessCallback("acc:medium")).toEqual({
      threshold: "medium",
    });
    expect(parseTelegramAccessCallback("acc:none")).toEqual({
      threshold: "none",
    });
    expect(parseTelegramAccessCallback("acc:not-a-threshold")).toBeNull();
  });
});

describe("telegram guardian command gate", () => {
  beforeEach(() => {
    sendTelegramReplyMock.mockClear();
    resolveTrustVerdictMock.mockClear();
    forkTelegramTopicMock.mockClear();
    resolveTrustVerdictMock.mockImplementation(() =>
      Promise.resolve({ trustClass: "unknown" }),
    );
  });

  it("allows guardians through ensureTelegramGuardianActor", async () => {
    resolveTrustVerdictMock.mockImplementation(() =>
      Promise.resolve({ trustClass: "guardian" }),
    );

    const allowed = await ensureTelegramGuardianActor({
      config: baseConfig,
      chatId: "42",
      threadId: "777",
      actorExternalId: "user-123",
    });

    expect(allowed).toBe(true);
    expect(sendTelegramReplyMock).not.toHaveBeenCalled();
  });

  it("denies non-guardians with a shared message", async () => {
    const allowed = await ensureTelegramGuardianActor({
      config: baseConfig,
      chatId: "42",
      actorExternalId: "user-123",
    });

    expect(allowed).toBe(false);
    expect(sendTelegramReplyMock).toHaveBeenCalledTimes(1);
    expect((sendTelegramReplyMock.mock.calls[0] as unknown[])[2]).toBe(
      TELEGRAM_GUARDIAN_COMMAND_DENIED,
    );
  });

  it("blocks /fork for non-guardians before calling the runtime", async () => {
    await handleTelegramForkCommand({
      config: baseConfig,
      chatId: "42",
      threadId: "777",
      actorExternalId: "user-123",
      logger,
    });

    expect(forkTelegramTopicMock).not.toHaveBeenCalled();
    expect(sendTelegramReplyMock).toHaveBeenCalledTimes(1);
    expect((sendTelegramReplyMock.mock.calls[0] as unknown[])[2]).toBe(
      TELEGRAM_GUARDIAN_COMMAND_DENIED,
    );
  });

  it("does not gate /help", async () => {
    await handleTelegramHelpCommand({
      config: baseConfig,
      chatId: "42",
      logger,
    });

    expect(resolveTrustVerdictMock).not.toHaveBeenCalled();
    expect(sendTelegramReplyMock).toHaveBeenCalledTimes(1);
    expect(
      String((sendTelegramReplyMock.mock.calls[0] as unknown[])[2]),
    ).toContain("Available commands:");
  });
});
