/**
 * Unit tests for the Phase 4 PR 3 `avatarEnabled` option on the
 * chrome-launcher primitive.
 *
 * These assertions are deliberately strict:
 *
 *   1. With `avatarEnabled` absent or explicitly `false`, the composed
 *      argv must be byte-identical to the pre-PR-3 baseline. Any drift
 *      would silently change the Phase 1 non-avatar launch path — exactly
 *      what the plan's acceptance criteria forbid.
 *   2. With `avatarEnabled: true`, both avatar flags
 *      (`--use-fake-device-for-media-stream` and
 *      `--use-file-for-fake-video-capture=<path>`) must appear in the
 *      argv, in that order, AFTER `--use-fake-ui-for-media-stream` so the
 *      camera-source toggles live adjacent to the permission-prompt
 *      toggle.
 *   3. The existing `--use-fake-ui-for-media-stream` permission-prompt
 *      flag must survive in both modes — without it, Chrome pops a
 *      runtime camera-permission dialog the bot can't click.
 *   4. The avatar device-path default is `/dev/video10` (matching
 *      `DEFAULT_VIDEO_DEVICE_PATH` in `src/media/video-device.ts` and the
 *      CLI's `VELLUM_MEET_AVATAR_DEVICE` default), and an explicit
 *      override threads through to the `--use-file-for-fake-video-capture`
 *      argument.
 *   5. CDP trip-wires (`--remote-debugging-*`, `--enable-automation`)
 *      remain absent in avatar mode — Meet's BotGuard rejects any CDP
 *      attachment regardless of the camera source.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  DEFAULT_AVATAR_DEVICE_PATH,
  launchChrome,
} from "../src/browser/chrome-launcher.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; stdio?: unknown };
}

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 54321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

function makeFakeSpawn(fakeChild: FakeChild): {
  spawn: never;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const impl = (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; stdio?: unknown },
  ) => {
    calls.push({ command, args: [...args], options });
    return fakeChild;
  };
  return { spawn: impl as unknown as never, calls };
}

const BASE_OPTS = {
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  displayNumber: ":99",
  extensionPath: "/app/ext",
  userDataDir: "/tmp/profile",
};

/**
 * The exact argv the launcher emits when `avatarEnabled` is absent or
 * false. This snapshot is the acceptance criterion's "pre-PR baseline" —
 * any change to the launch flags (adding, removing, reordering) breaks
 * this test intentionally so the author reviews the impact on the Phase
 * 1 no-avatar flow.
 */
const BASELINE_ARGV: readonly string[] = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-setuid-sandbox",
  "--disable-background-networking",
  "--disable-breakpad",
  "--window-size=1280,720",
  "--window-position=0,0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--use-fake-ui-for-media-stream",
  "--enable-logging=stderr",
  "--v=0",
  "--user-data-dir=/tmp/profile",
  "--load-extension=/app/ext",
  "https://meet.google.com/abc-defg-hij",
];

describe("launchChrome avatarEnabled flag", () => {
  test("default (avatarEnabled undefined) matches pre-PR-3 baseline byte-for-byte", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({ ...BASE_OPTS, spawn: fake.spawn });

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.args).toEqual([...BASELINE_ARGV]);
  });

  test("avatarEnabled: false is equivalent to undefined", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      avatarEnabled: false,
      spawn: fake.spawn,
    });

    expect(fake.calls[0]!.args).toEqual([...BASELINE_ARGV]);
  });

  test("avatarEnabled: false ignores avatarDevicePath override", async () => {
    // Sanity-check: an avatarDevicePath override without avatarEnabled
    // must NOT leak into the argv. The flag gates the whole avatar-arg
    // bundle; a stray path should be silently dropped.
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      avatarEnabled: false,
      avatarDevicePath: "/dev/video42",
      spawn: fake.spawn,
    });

    expect(fake.calls[0]!.args).toEqual([...BASELINE_ARGV]);
  });

  test("avatarEnabled: true appends both avatar flags in deterministic order", async () => {
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      avatarEnabled: true,
      spawn: fake.spawn,
    });

    const { args } = fake.calls[0]!;

    // Both avatar flags are present.
    expect(args).toContain("--use-fake-device-for-media-stream");
    expect(args).toContain(
      `--use-file-for-fake-video-capture=${DEFAULT_AVATAR_DEVICE_PATH}`,
    );

    // They land adjacent to each other, immediately after the always-on
    // `--use-fake-ui-for-media-stream`. This gives the reviewer a
    // deterministic string they can grep for across logs.
    const fakeUiIdx = args.indexOf("--use-fake-ui-for-media-stream");
    const fakeDeviceIdx = args.indexOf(
      "--use-fake-device-for-media-stream",
    );
    const fakeFileIdx = args.indexOf(
      `--use-file-for-fake-video-capture=${DEFAULT_AVATAR_DEVICE_PATH}`,
    );
    expect(fakeUiIdx).toBeGreaterThanOrEqual(0);
    expect(fakeDeviceIdx).toBe(fakeUiIdx + 1);
    expect(fakeFileIdx).toBe(fakeDeviceIdx + 1);

    // And the argv's final element is still the meeting URL — the avatar
    // flags must never reorder the URL to a non-terminal position (Chrome
    // treats any bare positional as the initial URL).
    expect(args[args.length - 1]).toBe(BASE_OPTS.meetingUrl);
  });

  test("avatarEnabled: true yields a full expected argv", async () => {
    // Explicit equality against the expected ordered shape — this is the
    // deterministic-order acceptance criterion from the plan.
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      avatarEnabled: true,
      spawn: fake.spawn,
    });

    expect(fake.calls[0]!.args).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--disable-background-networking",
      "--disable-breakpad",
      "--window-size=1280,720",
      "--window-position=0,0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${DEFAULT_AVATAR_DEVICE_PATH}`,
      "--enable-logging=stderr",
      "--v=0",
      "--user-data-dir=/tmp/profile",
      "--load-extension=/app/ext",
      "https://meet.google.com/abc-defg-hij",
    ]);
  });

  test("avatarDevicePath override threads into --use-file-for-fake-video-capture", async () => {
    // Operators running v4l2loopback with a custom `video_nr` point the
    // device path to something other than `/dev/video10` via the CLI's
    // `VELLUM_MEET_AVATAR_DEVICE` env; that value flows through the
    // session manager as `avatarDevicePath`.
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      avatarEnabled: true,
      avatarDevicePath: "/dev/video11",
      spawn: fake.spawn,
    });

    const { args } = fake.calls[0]!;
    expect(args).toContain(
      "--use-file-for-fake-video-capture=/dev/video11",
    );
    // Default path must NOT appear when an override is provided.
    expect(args).not.toContain(
      `--use-file-for-fake-video-capture=${DEFAULT_AVATAR_DEVICE_PATH}`,
    );
  });

  test("--use-fake-ui-for-media-stream survives in both modes", async () => {
    // The permission-prompt auto-accept is load-bearing for either launch
    // path: disabling it would make Chrome pop a camera-perm dialog the
    // bot can't click.
    for (const avatarEnabled of [true, false]) {
      const child = makeFakeChild();
      const fake = makeFakeSpawn(child);

      await launchChrome({
        ...BASE_OPTS,
        avatarEnabled,
        spawn: fake.spawn,
      });

      expect(fake.calls[0]!.args).toContain("--use-fake-ui-for-media-stream");
    }
  });

  test("avatar mode does NOT reintroduce any CDP trip-wire flag", async () => {
    // Same trip-wires the base launcher test (`chrome-launcher.test.ts`)
    // asserts against — re-checked here to pin the invariant under the
    // new avatar branch. BotGuard's CDP detection is orthogonal to the
    // camera source, so adding `--remote-debugging-*` in the avatar
    // branch would be just as fatal as adding it to the base argv.
    const child = makeFakeChild();
    const fake = makeFakeSpawn(child);

    await launchChrome({
      ...BASE_OPTS,
      avatarEnabled: true,
      spawn: fake.spawn,
    });

    for (const arg of fake.calls[0]!.args) {
      expect(arg.startsWith("--remote-debugging-port")).toBe(false);
      expect(arg.startsWith("--remote-debugging-pipe")).toBe(false);
      expect(arg.startsWith("--enable-automation")).toBe(false);
    }
  });

  test("DEFAULT_AVATAR_DEVICE_PATH is /dev/video10 (mirrors PR 2)", async () => {
    // Lock the default string so a future edit can't silently drift from
    // `DEFAULT_VIDEO_DEVICE_PATH` in `src/media/video-device.ts` or from
    // `DEFAULT_MEET_AVATAR_DEVICE_PATH` in `cli/src/lib/docker.ts`. All
    // three must agree.
    expect(DEFAULT_AVATAR_DEVICE_PATH).toBe("/dev/video10");
  });
});
