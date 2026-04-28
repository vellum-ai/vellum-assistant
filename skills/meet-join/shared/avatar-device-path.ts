/**
 * Single source of truth for the default v4l2loopback virtual-camera
 * device path used by the Meet bot's avatar pipeline.
 *
 * Three skill-internal modules depend on this value agreeing:
 *
 *   1. `skills/meet-join/config-schema.ts` — workspace config default for
 *      `services.meet.avatar.devicePath`.
 *   2. `skills/meet-join/bot/src/browser/chrome-launcher.ts` — fallback for
 *      Chrome's `--use-file-for-fake-video-capture` camera-source flag when
 *      the caller doesn't override.
 *   3. `skills/meet-join/bot/src/media/video-device.ts` — fallback device
 *      path the renderer opens for `write()`-ing raw Y4M frames.
 *
 * The CLI and platform template define the same default independently —
 * they must NOT import from skills (see `cli/AGENTS.md`).
 *
 * To change the default, bump the string here and rebuild. The value must
 * match the `video_nr=` option used when loading v4l2loopback on the host
 * (see `skills/meet-join/bot/README.md` § host setup).
 */
export const AVATAR_DEVICE_PATH_DEFAULT = "/dev/video10";
