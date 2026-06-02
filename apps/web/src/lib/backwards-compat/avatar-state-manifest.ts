/**
 * Backwards-compat gate: avatar state manifest (`GET /avatar/state` +
 * `POST /avatar/image`).
 *
 * The avatar state manifest makes `avatar.json` the authoritative source
 * of the render mode (`character` | `image` | `none`) and adds two new
 * daemon routes: `GET /avatar/state` (read the manifest) and
 * `POST /avatar/image` (upload a custom image through the atomic store).
 * Both first ship in the assistant version below.
 *
 * On older assistants those routes don't exist, so the web client must
 * fall back to the pre-manifest behavior — infer the render mode from the
 * workspace sidecar files (`avatar-image.png` / `character-traits.json`)
 * and upload a custom image by writing the PNG and deleting the traits
 * sidecar directly via the generic `workspace/write` + `workspace/delete`
 * routes, which every supported assistant understands.
 *
 * NOTE: `supportsAvatarStateManifest` reads the version snapshot via
 * `useAssistantIdentityStore.getState()` so it's safe to call from
 * non-hook contexts (the `uploadAvatarImage` request builder). React-render
 * paths that should re-render when the version flips use the
 * `useSupportsAvatarStateManifest` hook so the avatar query re-runs through
 * the correct path the moment the assistant version resolves.
 */
import {
  assistantSupports,
  useAssistantSupports,
  whenAssistantVersionKnown,
} from "./utils";

export const MIN_VERSION = "0.8.7";

/**
 * Returns `true` when the active assistant exposes the avatar state
 * manifest routes. Snapshot variant for non-hook contexts (request
 * builders, event handlers).
 *
 * Returns `false` while the identity store has no version yet, when the
 * version is unparseable, or when it falls below `MIN_VERSION`. Callers
 * must keep the legacy workspace-file path alive on the `false` branch.
 */
export function supportsAvatarStateManifest(): boolean {
  return assistantSupports(MIN_VERSION);
}

/**
 * Hook variant of {@link supportsAvatarStateManifest}: subscribes to the
 * identity store so consumers re-render (and re-fetch) when the active
 * assistant's version crosses `MIN_VERSION`.
 */
export function useSupportsAvatarStateManifest(): boolean {
  return useAssistantSupports(MIN_VERSION);
}

/**
 * Async variant of {@link supportsAvatarStateManifest} for the avatar
 * upload write path: waits (bounded) for the assistant version to
 * hydrate before reading the gate.
 *
 * The sync snapshot returns `false` until the version resolves, and the
 * upload fallback for `false` writes the legacy sidecar PNG directly via
 * `workspace/write`. On a manifest-capable assistant that legacy write
 * is shadowed by the authoritative `avatar.json` — the daemon only
 * self-heals from sidecars on a manifest-miss, so an existing manifest
 * keeps `GET /avatar/state` returning the stale render mode and the
 * upload silently no-ops. Awaiting the version first ensures the path
 * decision is made against a resolved version, never the pre-hydration
 * default. Reads don't need this: they're idempotent and re-run through
 * `useSupportsAvatarStateManifest` the moment the version flips.
 */
export async function resolveSupportsAvatarStateManifest(): Promise<boolean> {
  await whenAssistantVersionKnown();
  return supportsAvatarStateManifest();
}
