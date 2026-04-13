#!/usr/bin/env bun
/**
 * CLI for vellum-sounds skill: `bun run scripts/update-config.ts`
 *
 * Safely reads and writes $VELLUM_WORKSPACE_DIR/data/sounds/config.json,
 * the configuration file consumed by the macOS app's SoundManager. Validates
 * inputs, creates the file with defaults if missing, and writes atomically.
 *
 * Each event holds a **pool** of sound filenames (`sounds: string[]`). The
 * macOS app picks one at random on playback. An empty pool means "use the
 * default macOS blip." This script also reads legacy single-sound entries
 * (`{"sound": "foo.wav"}`) and normalizes them to the new pool shape on write.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const SUPPORTED_EXTENSIONS = ["aiff", "wav", "mp3", "m4a", "caf"] as const;

const EVENT_KEYS = [
  "app_open",
  "task_complete",
  "needs_input",
  "task_failed",
  "notification",
  "new_conversation",
  "message_sent",
  "character_poke",
  "random",
] as const;

type EventKey = (typeof EVENT_KEYS)[number];

interface SoundEventConfig {
  enabled: boolean;
  sounds: string[];
}

interface SoundsConfig {
  globalEnabled: boolean;
  volume: number;
  events: Record<string, SoundEventConfig>;
}

function defaultConfig(): SoundsConfig {
  const events: Record<string, SoundEventConfig> = {};
  for (const key of EVENT_KEYS) {
    events[key] = { enabled: false, sounds: [] };
  }
  return { globalEnabled: false, volume: 0.7, events };
}

function printUsage(): void {
  process.stderr.write(`Usage: bun run scripts/update-config.ts [options]

Edit data/sounds/config.json in the current workspace. Creates the file with
defaults if it doesn't exist. Writes atomically.

Each event holds a pool of sound filenames; the macOS app picks one at random
on playback. An empty pool falls back to the default macOS blip.

Options:
  --global-enabled <true|false>   Master on/off for all sounds.
  --volume <float>                 Master volume, 0.0–1.0 (clamped).
  --event <key>                    One of: ${EVENT_KEYS.join(", ")}
  --enabled <true|false>           Per-event on/off (requires --event).

  Pool mutation flags (all require --event; at most one per invocation,
  except --add-sound which may be repeated):
  --sound <filename|null>          Single-sound convenience: replaces the
                                   whole pool with one entry, or clears it
                                   when given "null".
  --sounds <csv>                   Replaces the pool with the comma-separated
                                   list (e.g. "a.wav,b.wav,c.wav"). Use
                                   --clear-sounds to empty.
  --add-sound <filename>           Appends to the pool. No-op (warning) if
                                   already present. May be repeated.
  --remove-sound <filename>        Removes an entry. No-op (warning) if not
                                   present.
  --clear-sounds                   Sets the pool to [].

  --help, -h                       Show this help.

Examples:
  bun run scripts/update-config.ts --global-enabled true
  bun run scripts/update-config.ts --volume 0.5
  bun run scripts/update-config.ts --event message_sent --enabled true --sound "gentle-ding.aiff"
  bun run scripts/update-config.ts --event character_poke --sounds "poke1.wav,poke2.wav,poke3.wav"
  bun run scripts/update-config.ts --event character_poke --add-sound "poke4.wav"
  bun run scripts/update-config.ts --event character_poke --remove-sound "poke2.wav"
  bun run scripts/update-config.ts --event character_poke --clear-sounds
  bun run scripts/update-config.ts --event task_complete --sound null
`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/**
 * Tagged union describing which pool-mutation operation the user requested.
 * Exactly one variant is allowed per invocation (except `add`, which accepts
 * multiple filenames via repeated `--add-sound` flags).
 */
type PoolOp =
  | { kind: "sound"; value: string | null }
  | { kind: "sounds"; values: string[] }
  | { kind: "add"; values: string[] }
  | { kind: "remove"; value: string }
  | { kind: "clear" };

interface ParsedArgs {
  globalEnabled?: boolean;
  volume?: number;
  event?: EventKey;
  enabled?: boolean;
  poolOp?: PoolOp;
  help: boolean;
}

function parseBool(raw: string, flag: string): boolean {
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  fail(`${flag} must be "true" or "false" (got "${raw}")`);
}

function parseCsv(raw: string, flag: string): string[] {
  if (raw === "") {
    fail(`${flag} must not be empty (use --clear-sounds to empty the pool)`);
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    fail(`${flag} must contain at least one non-empty filename`);
  }
  return parts;
}

function setPoolOp(out: ParsedArgs, op: PoolOp, flag: string): void {
  // Multiple --add-sound flags merge; any other combination is an error.
  if (out.poolOp) {
    if (out.poolOp.kind === "add" && op.kind === "add") {
      out.poolOp.values.push(...op.values);
      return;
    }
    fail(
      `${flag} is mutually exclusive with --sound, --sounds, --remove-sound, ` +
        `and --clear-sounds. Only --add-sound may be repeated.`,
    );
  }
  out.poolOp = op;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) fail(`${arg} requires a value`);
      i++;
      return v;
    };
    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--global-enabled":
        out.globalEnabled = parseBool(next(), arg);
        break;
      case "--volume": {
        const raw = next();
        const n = Number(raw);
        if (!Number.isFinite(n)) fail(`--volume must be a number (got "${raw}")`);
        out.volume = Math.max(0, Math.min(1, n));
        break;
      }
      case "--event": {
        const raw = next();
        if (!(EVENT_KEYS as readonly string[]).includes(raw)) {
          fail(
            `--event must be one of: ${EVENT_KEYS.join(", ")} (got "${raw}")`,
          );
        }
        out.event = raw as EventKey;
        break;
      }
      case "--enabled":
        out.enabled = parseBool(next(), arg);
        break;
      case "--sound": {
        const raw = next();
        setPoolOp(out, { kind: "sound", value: raw === "null" ? null : raw }, arg);
        break;
      }
      case "--sounds": {
        const raw = next();
        setPoolOp(out, { kind: "sounds", values: parseCsv(raw, arg) }, arg);
        break;
      }
      case "--add-sound": {
        const raw = next();
        if (raw === "") fail(`${arg} must not be empty`);
        setPoolOp(out, { kind: "add", values: [raw] }, arg);
        break;
      }
      case "--remove-sound": {
        const raw = next();
        if (raw === "") fail(`${arg} must not be empty`);
        setPoolOp(out, { kind: "remove", value: raw }, arg);
        break;
      }
      case "--clear-sounds":
        setPoolOp(out, { kind: "clear" }, arg);
        break;
      default:
        fail(`Unknown flag: ${arg}`);
    }
  }
  return out;
}

function resolveSoundsDir(): string {
  const workspace = process.env.VELLUM_WORKSPACE_DIR;
  if (!workspace) {
    fail(
      "VELLUM_WORKSPACE_DIR is not set. This script must run inside the Vellum skill sandbox.",
    );
  }
  return join(workspace, "data", "sounds");
}

function readConfig(path: string): SoundsConfig {
  if (!existsSync(path)) return defaultConfig();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fail(`Failed to read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const base = defaultConfig();
  const p = parsed as Partial<SoundsConfig> | null;
  if (p && typeof p === "object") {
    if (typeof p.globalEnabled === "boolean") {
      base.globalEnabled = p.globalEnabled;
    }
    if (typeof p.volume === "number" && Number.isFinite(p.volume)) {
      base.volume = Math.max(0, Math.min(1, p.volume));
    }
    if (p.events && typeof p.events === "object") {
      for (const key of EVENT_KEYS) {
        const entry = (p.events as Record<string, unknown>)[key];
        if (entry && typeof entry === "object") {
          const e = entry as {
            enabled?: unknown;
            sounds?: unknown;
            sound?: unknown;
          };
          if (typeof e.enabled === "boolean") base.events[key].enabled = e.enabled;
          // Match the Swift decoder (SoundsConfig.swift): prefer the new
          // `sounds` array; fall back to the legacy single `sound` string;
          // otherwise leave the pool empty. Filter out non-string / empty
          // entries defensively so a malformed pool never hits playback.
          if (Array.isArray(e.sounds)) {
            base.events[key].sounds = e.sounds.filter(
              (s): s is string => typeof s === "string" && s.length > 0,
            );
          } else if (typeof e.sound === "string" && e.sound.length > 0) {
            base.events[key].sounds = [e.sound];
          } else {
            base.events[key].sounds = [];
          }
        }
      }
    }
  }
  return base;
}

function writeConfigAtomic(path: string, config: SoundsConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const body = JSON.stringify(config, null, 2) + "\n";
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    fail(`Failed to write ${path}: ${(err as Error).message}`);
  }
}

function validateSoundFilename(soundsDir: string, filename: string): void {
  if (filename.includes("/") || filename.includes("\\")) {
    fail(`sound filename must not contain path separators (got "${filename}")`);
  }
  if (filename.startsWith(".")) {
    fail(`sound filename must not start with "." (got "${filename}")`);
  }
  const dotIdx = filename.lastIndexOf(".");
  const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : "";
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    fail(
      `sound filename must have a supported extension (${SUPPORTED_EXTENSIONS.join(", ")}); got ".${ext}"`,
    );
  }
  const full = join(soundsDir, filename);
  if (!existsSync(full)) {
    fail(
      `Sound file not found at ${full}. Copy it into data/sounds/ first, then rerun.`,
    );
  }
}

function applyPoolOp(
  soundsDir: string,
  eventConfig: SoundEventConfig,
  op: PoolOp,
): void {
  switch (op.kind) {
    case "sound": {
      // Single-sound convenience: replace the whole pool.
      if (op.value === null) {
        eventConfig.sounds = [];
      } else {
        validateSoundFilename(soundsDir, op.value);
        eventConfig.sounds = [op.value];
      }
      return;
    }
    case "sounds": {
      for (const name of op.values) {
        validateSoundFilename(soundsDir, name);
      }
      eventConfig.sounds = [...op.values];
      return;
    }
    case "add": {
      for (const name of op.values) {
        validateSoundFilename(soundsDir, name);
        if (eventConfig.sounds.includes(name)) {
          process.stderr.write(
            `Warning: "${name}" is already in the pool; skipping.\n`,
          );
          continue;
        }
        eventConfig.sounds.push(name);
      }
      return;
    }
    case "remove": {
      const idx = eventConfig.sounds.indexOf(op.value);
      if (idx < 0) {
        process.stderr.write(
          `Warning: "${op.value}" is not in the pool; nothing to remove.\n`,
        );
        return;
      }
      eventConfig.sounds.splice(idx, 1);
      return;
    }
    case "clear": {
      eventConfig.sounds = [];
      return;
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const hasEventFlag = args.enabled !== undefined || args.poolOp !== undefined;
  if (hasEventFlag && !args.event) {
    fail(
      "--enabled, --sound, --sounds, --add-sound, --remove-sound, and --clear-sounds require --event",
    );
  }
  if (
    args.globalEnabled === undefined &&
    args.volume === undefined &&
    args.event === undefined
  ) {
    printUsage();
    fail("No changes requested");
  }

  const soundsDir = resolveSoundsDir();
  const configPath = join(soundsDir, "config.json");
  const config = readConfig(configPath);

  const changed: Record<string, unknown> = {};

  if (args.globalEnabled !== undefined) {
    config.globalEnabled = args.globalEnabled;
    changed.globalEnabled = config.globalEnabled;
  }
  if (args.volume !== undefined) {
    config.volume = args.volume;
    changed.volume = config.volume;
  }
  if (args.event) {
    const eventConfig = config.events[args.event];
    if (args.enabled !== undefined) eventConfig.enabled = args.enabled;
    if (args.poolOp) applyPoolOp(soundsDir, eventConfig, args.poolOp);
    changed[`events.${args.event}`] = eventConfig;
  }

  writeConfigAtomic(configPath, config);

  process.stdout.write(
    JSON.stringify({ ok: true, path: configPath, changed }, null, 2) + "\n",
  );
}

main();
