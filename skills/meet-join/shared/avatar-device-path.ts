/**
 * Single source of truth for the default v4l2loopback virtual-camera
 * device path used by the Meet bot's avatar pipeline.
 *
 * Four separate modules depend on this value agreeing across boundaries:
 *
 *   1. `skills/meet-join/config-schema.ts` — workspace config default for
 *      `services.meet.avatar.devicePath`.
 *   2. `skills/meet-join/bot/src/browser/chrome-launcher.ts` — fallback for
 *      Chrome's `--use-file-for-fake-video-capture` camera-source flag when
 *      the caller doesn't override.
 *   3. `skills/meet-join/bot/src/media/video-device.ts` — fallback device
 *      path the renderer opens for `write()`-ing raw Y4M frames.
 *   4. `cli/src/lib/docker.ts` — default path bind-mounted into the
 *      assistant container via `--device` when `VELLUM_MEET_AVATAR=1`.
 *
 * If one bumps to `/dev/video11` and the others don't, Chrome, the renderer,
 * and the device-passthrough wiring silently disagree — Meet either gets a
 * black frame, ENOENT on the device open, or both. Previously each module
 * declared the string locally with comments pointing at the others; this
 * file replaces those comment-driven pacts with a hard import so drift is
 * impossible by construction.
 *
 * This module is intentionally zero-dependency (no `zod`, no `node:fs`, no
 * package-local imports) so every consumer — including the CLI, which
 * compiles to a standalone `bun build --compile` binary — can import it
 * without pulling in unrelated module surface.
 *
 * To change the default, bump the string here and rebuild. The value must
 * match the `video_nr=` option used when loading v4l2loopback on the host
 * (see `skills/meet-join/bot/README.md` § host setup).
 */
export const AVATAR_DEVICE_PATH_DEFAULT = "/dev/video10";
