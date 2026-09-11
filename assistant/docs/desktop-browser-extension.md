# Managed desktop browser extension

The default-off `assistant-desktop` feature offers screenshot/X11 input and a
browser scope through the same `desktop_control` skill tool. The browser scope
uses the visible Chrome on display `:99` and its existing desktop profile.

## Provisioning

Opening the desktop after Install desktop builds the managed extension from
`clients/chrome-extension/background/managed-desktop-worker.ts`. It reuses the
existing `host-browser-dispatcher` and `cdp-proxy`, with a distinct native
transport and no general host-browser registration or personal-client fallback.

The installer produces a CRX3 package signed by a persistent RSA key under
`<Vellum root>/protected/desktop-extension`, outside the workspace. It verifies
the signature before publishing the package. The public key determines the
stable installation ID. The same protected directory contains the native host
and its connection capability; neither is sent to page scripts or renderers.
The capability rotates on assistant process restart. It authorizes only this
managed browser transport, not guardian APIs or approval decisions.

Chrome reads the system policy in
`/etc/opt/chrome/policies/managed/vellum-desktop-extension.json` and the native
host manifest in `/etc/opt/chrome/native-messaging-hosts/ai.vellum.desktop.json`.
These are fixed Google Chrome Linux lookup paths, including for an extracted
Chrome package. No unpacked-extension launch switch is used. Extension updates
and CRX downloads go through the assistant's internal gateway URL. The native
host accepts only the installed extension origin and matching protocol/version.
It checks the parent Chrome executable, desktop profile, and display `:99`, so
another profile cannot register this managed connection. Guardian identity comes from
the gateway's canonical active guardian binding, never a request-supplied actor.

Bump `DESKTOP_EXTENSION_VERSION` when changing the packaged extension. Retain
the installation signing key when upgrading the assistant; changing the key
changes the extension ID. The installed extension owns no durable task data.
The Chrome profile, cookies, and signed-in state remain in the desktop profile.

## Control and recovery

The browser channel is separate from the general extension SSE roster. Generic
browser commands cannot dispatch to it, including by explicit client ID.
`DesktopControl` owns guardian/conversation admission, queue serialization,
Take control, Allow assistant, action budget, and desktop lifetime for both
input scopes. Browser observations include page text, controls, tabs, and
frames. They contain no unconditional image. Element references bind to tab,
frame, document loader, and connection generation.

The native connection automatically restarts after disconnect and discards
outstanding requests. There is no action retry after dispatch. A command may
have reached Chrome even if cancellation or a timeout prevents its response.
Observe before deciding how to continue. Input cleanup issues key/button
releases, including when the original press has an outstanding response.

Embedded frames support reading when exposed by the selected target's AX tree;
input in frames, canvas, native Chrome UI, password/file fields, and other
applications uses screenshot/X11 fallback. Large responses above the transport
cap fail instead of silently truncating references. Native input races with
page-authored movement cannot be eliminated entirely after validation.

## Validation

Scoped tests cover capability/guardian binding, callback connection binding,
reconnect invalidation, queued cancellation, shared X11/browser ownership,
actionability rejection, and input release. The Linux-only
`scripts/smoke-desktop-extension.ts` uses a temporary workspace and real Chrome
on `:99` to exercise signed policy installation, native bootstrap, AX reading,
semantic click, and stale-reference rejection. Its gateway is a test stub;
gateway guardian stamping and ingress bounds have separate tests.

References: [Chrome external installation](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions),
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger),
and [CRX3 format](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto).
