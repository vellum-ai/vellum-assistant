import { describe, expect, it } from "bun:test";

import {
  parseTelegramAccessCallback,
  parseTelegramAccessCommand,
  parseTelegramArchiveCommand,
  parseTelegramForkCommand,
  parseTelegramHelpCommand,
  parseTelegramProfileCallback,
  parseTelegramProfileCommand,
  parseTelegramRenameCommand,
  parseTelegramStopCommand,
} from "./topic-commands.js";

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
