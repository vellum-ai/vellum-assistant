import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { ConfigFileCache } from "../config-file-cache.js";
import { testWorkspaceDir } from "../__tests__/test-preload.js";
import { admitDiscordMessage, type AdmissionCandidate } from "./admit.js";
import { readDiscordAllowedChannelIds } from "./allowed-channels.js";

/**
 * These cases cover the full path from a real `config.json` on disk, through
 * `ConfigFileCache`, into the set the admission gate receives, to a verdict.
 * The gate and the config reader are each correct in isolation, so a test that
 * hands the gate a hand-built `Set` cannot tell whether the stored value
 * actually reaches it in the shape it expects. Only an on-disk config can.
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

/** A message that would be admitted: a human mentioning the bot in-channel. */
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
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  } catch {
    // best-effort
  }
});

describe("readDiscordAllowedChannelIds", () => {
  test("admits a mention when the allow-list is stored as a JSON array", () => {
    // A JSON array is the natural way to author a list by hand, and the only
    // safe way to author a snowflake, so it is the shape most likely to be on
    // disk.
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
    // Accepting more shapes widens which values are readable, not which rooms
    // are admitted.
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
