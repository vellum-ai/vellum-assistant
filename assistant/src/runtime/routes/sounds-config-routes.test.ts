/**
 * Tests for the dedicated sounds-config route handlers.
 *
 * The sounds config `events` map is an open record (`z.record(z.string(), ...)`),
 * so event keys this app doesn't define — notably `app_open`, which the native
 * macOS client writes and configures — must survive a GET (read/normalise) and a
 * full PUT round-trip without being dropped. These tests pin that invariant.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getSoundsDir } from "../../util/platform.js";
import { ROUTES } from "./sounds-config-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface SoundEventConfig {
  enabled: boolean;
  sounds: string[];
}

interface SoundsConfig {
  globalEnabled: boolean;
  volume: number;
  events: Record<string, SoundEventConfig>;
}

function findHandler(operationId: string): (args: RouteHandlerArgs) => unknown {
  const route: RouteDefinition | undefined = ROUTES.find(
    (r) => r.operationId === operationId,
  );
  if (!route) throw new Error(`No route found for operationId: ${operationId}`);
  return route.handler;
}

const getConfigHandler = findHandler("sounds_config_get");
const putConfigHandler = findHandler("sounds_config_put");

function getConfig(): SoundsConfig {
  return getConfigHandler({}) as SoundsConfig;
}

function putConfig(body: SoundsConfig): SoundsConfig {
  // `RouteHandlerArgs.body` is an untyped `Record<string, unknown>`; widen our
  // concrete config to match. Callers still pass a fully-typed `SoundsConfig`.
  return putConfigHandler({
    body: body as unknown as Record<string, unknown>,
  }) as SoundsConfig;
}

const configPath = () => join(getSoundsDir(), "config.json");

function writeRawConfig(value: unknown): void {
  const dir = getSoundsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(value, null, 2), "utf-8");
}

function readRawConfig(): SoundsConfig {
  return JSON.parse(readFileSync(configPath(), "utf-8")) as SoundsConfig;
}

// `app_open` is configured by the native macOS client but is NOT in the web
// app's SOUND_EVENT_IDS, so it stands in for "an event key this app doesn't
// know about".
const FOREIGN_EVENT = "app_open";

beforeEach(() => {
  rmSync(configPath(), { force: true });
});

afterEach(() => {
  rmSync(configPath(), { force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sounds config routes — unknown event preservation (LUM-2302)", () => {
  test("GET preserves a foreign event key while merging known defaults", () => {
    writeRawConfig({
      globalEnabled: true,
      volume: 0.5,
      events: {
        [FOREIGN_EVENT]: { enabled: true, sounds: ["chime.wav"] },
        task_complete: { enabled: true, sounds: ["done.mp3"] },
      },
    });

    const config = getConfig();

    // Foreign key survives normalisation untouched.
    expect(config.events[FOREIGN_EVENT]).toEqual({
      enabled: true,
      sounds: ["chime.wav"],
    });
    // Explicitly-set known event is preserved as written.
    expect(config.events.task_complete).toEqual({
      enabled: true,
      sounds: ["done.mp3"],
    });
    // Known events absent from the file are still backfilled with defaults.
    expect(config.events.needs_input).toEqual({ enabled: false, sounds: [] });
  });

  test("PUT round-trips a foreign event key to disk and back", () => {
    const body: SoundsConfig = {
      globalEnabled: true,
      volume: 0.8,
      events: {
        [FOREIGN_EVENT]: { enabled: true, sounds: ["startup.aiff"] },
        message_sent: { enabled: false, sounds: [] },
      },
    };

    const returned = putConfig(body);

    // The handler echoes the foreign key back in its response...
    expect(returned.events[FOREIGN_EVENT]).toEqual({
      enabled: true,
      sounds: ["startup.aiff"],
    });
    // ...and persists it to disk verbatim...
    expect(readRawConfig().events[FOREIGN_EVENT]).toEqual({
      enabled: true,
      sounds: ["startup.aiff"],
    });
    // ...so a subsequent GET still sees it (full client round-trip).
    expect(getConfig().events[FOREIGN_EVENT]).toEqual({
      enabled: true,
      sounds: ["startup.aiff"],
    });
  });

  test("editing one known event via PUT does not drop a pre-existing foreign key", () => {
    // Simulate the native client having written an app_open entry first.
    writeRawConfig({
      globalEnabled: false,
      volume: 0.7,
      events: {
        [FOREIGN_EVENT]: { enabled: true, sounds: ["startup.aiff"] },
      },
    });

    // The web client reads, toggles a single known event, and writes back the
    // whole config (spreading the previous events it received from GET).
    const current = getConfig();
    const next: SoundsConfig = {
      ...current,
      events: {
        ...current.events,
        task_complete: { enabled: true, sounds: ["done.mp3"] },
      },
    };
    putConfig(next);

    // The pre-existing foreign key must still be on disk after the edit.
    expect(readRawConfig().events[FOREIGN_EVENT]).toEqual({
      enabled: true,
      sounds: ["startup.aiff"],
    });
  });
});
