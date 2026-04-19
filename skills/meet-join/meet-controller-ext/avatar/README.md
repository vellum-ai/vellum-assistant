# Vellum Meet avatar tab

This directory contains the assets the meet-bot's Chrome extension
loads into the pinned second tab that TalkingHead.js renders into.

## Files

- `avatar.html` — minimal page shell that loads the bundled
  `avatar.js` (produced by `scripts/build.ts` from
  `src/avatar/avatar.ts`).
- `default-avatar.glb` — **placeholder**; operators MUST replace this
  with a real Ready Player Me GLB model before Phase 4 is useful in
  production. See below.

The bundled `avatar.js` file is produced at build time and is NOT
checked into source. Only the TypeScript source
(`src/avatar/avatar.ts`) and this static HTML + placeholder GLB live
in the repo.

## Replacing the placeholder GLB

The shipped `default-avatar.glb` is a 0-byte placeholder. It is NOT a
valid GLB file. With the placeholder in place, TalkingHead.js fails
to load the model and the avatar tab falls back to streaming a
static colored background — the Meet camera stream is still live,
but there is no moving face.

### Option 1 — bundle a real model at build time

1. Generate a Ready Player Me avatar at
   [readyplayer.me](https://readyplayer.me/) (free account, no
   license fee). Choose the **3D avatar** option and make sure ARKit
   blendshapes are enabled (required for TalkingHead.js visemes).
2. Download the GLB.
3. Replace `skills/meet-join/meet-controller-ext/avatar/default-avatar.glb`
   with the downloaded file. The existing filename is load-bearing —
   don't rename it unless you also update
   `src/avatar/avatar.ts::resolveModelUrl`.
4. Rebuild the extension: `bun run build` inside
   `skills/meet-join/meet-controller-ext/`.

### Option 2 — override at runtime via config

The bot-side `services.meet.avatar.talkingHead.modelUrl` config key
overrides the URL the avatar page loads. When set, the bot passes it
through to `BotAvatarStartCommand.modelUrl`, the extension adds it
as a `?model=<url>` query string when opening the avatar tab, and
`avatar.ts::resolveModelUrl` prefers the URL over the bundled GLB.

This path is useful when the GLB lives on an object store or a
per-meeting endpoint rather than bundled into the extension.

## References

- TalkingHead.js: [`@met4citizen/talkinghead`](https://github.com/met4citizen/TalkingHead)
  (MIT licensed; v1.7.0 pinned in `package.json`).
- Ready Player Me: [docs.readyplayer.me](https://docs.readyplayer.me/)
  (avatars are royalty-free for the creator's own use).
- The v1 TalkingHead integration ignores the audio stream — lip-sync
  is driven entirely from `avatar.push_viseme` events the bot
  forwards. PR 9 (audio-playback alignment) will add an amplitude
  fallback when no viseme stream is active.
