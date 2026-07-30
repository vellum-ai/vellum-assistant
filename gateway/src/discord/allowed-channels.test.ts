import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { ConfigFileCache } from "../config-file-cache.js";
import { testWorkspaceDir } from "../__tests__/test-preload.js";
import { admitDiscordMessage, type AdmissionCandidate } from "./admit.js";
import { readDiscordAllowedChannelIds } from "./allowed-channels.js";

/**
 * These cases run the whole seam that was uncovered: a real `config.json` on
 * disk, through `ConfigFileCache`, into the set the admission gate receives,
 * to a verdict. The gate and the config reader were each unit-tested in
 * isolation and both were correct. The defect lived entirely in the join
 * between them, so a test that hands the gate a hand-built `Set` cannot see
 * it.
 */

const configPath = join(testWorkspaceDir, "config.json");

const BOT = "900000000000000001";
const HUMAN = "900000000000000002";
const CHANNEL = "1532468750740357331";
const OTHER_CHANNEL = "800000000000000002";
const GUILD = "670819210053681162";

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(data));
}

/** The Jul 30 smoke-test message: a human mentioning the bot in the channel. */
function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    channelId: CHANNEL,
    guildId: GUILD,
    authorId: HUMAN,
    mentionedUserIds: [BOT],
    ...over,
  };
}

/** Read the allow-list the way the client does, then run the gate. */
function admitWithStoredConfig(over: Partial<AdmissionCandidate> = {}) {
  const cache = new ConfigFileCache({ ttlMs: 0 });
  return admitDiscordMessage(candidate(over), {
    botUserId: BOT,
    allowedChannelIds: readDiscordAllowedChannelIds(cache),
  });
}

afterEach(() => {
  try {
    if (existsSync(configPath)) unlinkSync(configPath);
  } catch {
    // best-effort
  }
});

describe("readDiscordAllowedChannelIds", () => {
  test("admits a mention when the allow-list is stored as a JSON array", () => {
    // The regression. This is the exact shape in the live workspace config on
    // Jul 30, and it read as an empty allow-list, so every message in the
    // channel was denied while the log showed nothing at all.
    writeConfig({ discord: { allowedChannelIds: [CHANNEL] } });
    expect(admitWithStoredConfig()).toEqual({ admitted: true });
  });

  test("admits a mention when the allow-list is stored as a CSV string", () => {
    writeConfig({ discord: { allowedChannelIds: CHANNEL } });
    expect(admitWithStoredConfig()).toEqual({ admitted: true });
  });

  test("both shapes yield the same set for multiple channels", () => {
    writeConfig({ discord: { allowedChannelIds: [CHANNEL, OTHER_CHANNEL] } });
    const fromArray = readDiscordAllowedChannelIds(
      new ConfigFileCache({ ttlMs: 0 }),
    );

    writeConfig({
      discord: { allowedChannelIds: `${CHANNEL}, ${OTHER_CHANNEL}` },
    });
    const fromCsv = readDiscordAllowedChannelIds(
      new ConfigFileCache({ ttlMs: 0 }),
    );

    expect(fromArray).toEqual(new Set([CHANNEL, OTHER_CHANNEL]));
    expect(fromCsv).toEqual(fromArray);
  });

  test("a channel outside the stored array is still denied", () => {
    // The fix widens which shapes are readable, not which rooms are admitted.
    writeConfig({ discord: { allowedChannelIds: [OTHER_CHANNEL] } });
    expect(admitWithStoredConfig()).toEqual({
      admitted: false,
      reason: "channel_not_allowed",
    });
  });

  test("a thread inherits a parent listed in the stored array", () => {
    writeConfig({ discord: { allowedChannelIds: [CHANNEL] } });
    expect(
      admitWithStoredConfig({
        channelId: "800000000000000099",
        parentChannelId: CHANNEL,
      }),
    ).toEqual({ admitted: true });
  });

  test("an absent discord section admits nothing", () => {
    // Fail-closed stays fail-closed: an unconfigured list must not read as
    // "every channel the bot can see".
    writeConfig({});
    expect(
      readDiscordAllowedChannelIds(new ConfigFileCache({ ttlMs: 0 })),
    ).toEqual(new Set());
    expect(admitWithStoredConfig()).toEqual({
      admitted: false,
      reason: "channel_not_allowed",
    });
  });

  test("an empty array admits nothing", () => {
    writeConfig({ discord: { allowedChannelIds: [] } });
    expect(admitWithStoredConfig()).toEqual({
      admitted: false,
      reason: "channel_not_allowed",
    });
  });

  test("a truncated bare-integer snowflake is dropped, not coerced", () => {
    // `assistant config set` truncates bare integers above 2^53 (LUM-2939), so
    // by the time the value lands here the id is already wrong. Coercing it
    // would admit a channel nobody listed; dropping it denies and keeps the
    // misconfiguration visible.
    writeConfig({ discord: { allowedChannelIds: [1532468750740357331] } });
    expect(admitWithStoredConfig()).toEqual({
      admitted: false,
      reason: "channel_not_allowed",
    });
  });

  test("reads live so an allow-list edit applies without a restart", () => {
    // The client reads per message precisely so a config edit does not cost an
    // IDENTIFY. If the read were hoisted, this is the case that would break.
    writeConfig({ discord: { allowedChannelIds: [OTHER_CHANNEL] } });
    const cache = new ConfigFileCache({ ttlMs: 0 });
    expect(readDiscordAllowedChannelIds(cache)).toEqual(
      new Set([OTHER_CHANNEL]),
    );

    writeConfig({ discord: { allowedChannelIds: [CHANNEL] } });
    expect(readDiscordAllowedChannelIds(cache)).toEqual(new Set([CHANNEL]));
  });
});
