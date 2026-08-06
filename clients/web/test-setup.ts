/**
 * Test preload — registers happy-dom globals (window, document,
 * localStorage, sessionStorage, etc.) so component and hook tests
 * can run in Bun's test runner without a real browser.
 *
 * Loaded via `preload` in bunfig.toml.
 *
 * Reference: https://github.com/nicedoc/happy-dom/wiki/GlobalRegistrator
 */

import { plugin, type BunPlugin } from "bun";

import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Vite asset-URL query suffixes (`?worker&url`, `?url`, `?worker`) aren't
// understood by Bun's resolver. Production builds rely on Vite to turn these
// imports into emitted-asset URLs (e.g. the live-voice AudioWorklet); in tests
// we only need the import to resolve, so map any such specifier to a stub
// default export (the URL string). Tests that exercise the asset drive it
// through their own mocks rather than fetching the real URL.
const viteAssetUrlStub: BunPlugin = {
  name: "vite-asset-url-stub",
  setup(build) {
    build.onLoad({ filter: /\?(worker&url|url|worker)$/ }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js",
    }));
  },
};

plugin(viteAssetUrlStub);

// Tests default to platform mode (matching CI/CD builds). Individual tests
// that need local mode should mock isLocalClient() instead.
process.env.VITE_PLATFORM_MODE = "true";

// Set a base URL so relative fetch requests (e.g. "/v1/assistants/...")
// resolve correctly instead of failing against "about:blank".
window.location.href = "http://localhost:3000";

// happy-dom bug workaround: make `focus()` re-entrant-safe.
//
// `HTMLElementUtility.focus()` no-ops when the target is already
// `document.activeElement`, but it only assigns `activeElement = target`
// *after* synchronously dispatching `blur`/`focusout` on the outgoing
// element. During that dispatch `activeElement` is null, so a handler that
// focuses the same target again slips past the guard and recurses:
//
//   focus -> blur -> focusout handler -> focus -> blur -> ...
//
// A Radix Select inside a Radix Dialog hits this: the Select's option is
// portalled outside the Dialog, the Dialog's focus scope treats that as focus
// escaping and pulls it back to the trigger, and Radix Select re-focuses the
// option: option -> trigger -> option, forever. The runner then produces no
// output at all, because a synchronous loop is not interruptible by
// `--timeout`.
//
// Verified in a real browser (design-library Storybook, Select inside Modal):
// the menu opens, both options render, activeElement settles on the trigger.
// So this is a happy-dom defect, not a product bug, and the shim restores the
// browser behaviour rather than papering over ours. Focusing a *different*
// element from a blur handler still works, so nothing legitimate is lost.
const nativeFocus = window.HTMLElement.prototype.focus;
const focusStack = new Set<HTMLElement>();
window.HTMLElement.prototype.focus = function patchedFocus(
  this: HTMLElement,
  ...args: Parameters<typeof nativeFocus>
): void {
  // Re-entering a focus() that has not finished unwinding is the loop. A
  // set, not a single flag: the cycle alternates between two elements (the
  // portalled option and the trigger), so checking only the immediate
  // target never matches.
  if (focusStack.has(this)) {
    return;
  }
  focusStack.add(this);
  try {
    nativeFocus.apply(this, args);
  } finally {
    focusStack.delete(this);
  }
};
