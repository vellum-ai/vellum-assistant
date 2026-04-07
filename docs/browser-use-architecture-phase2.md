# Browser Use Architecture — Phase 2 notes

## chrome.debugger infobar

When the Chrome extension calls `chrome.debugger.attach(target, requiredVersion)`, Chrome displays a persistent yellow infobar at the top of the affected tab saying "Vellum started debugging this browser." This is an intentional security mitigation — it cannot be suppressed via the public MV3 API.

### Investigation (Phase 2)

- `chrome.debugger.attach(target, requiredVersion, callback)` — three-argument form, no options parameter. Chrome 120+. (https://developer.chrome.com/docs/extensions/reference/api/debugger)
- There is no `{ silent: true }` option on attach.
- The `--silent-debugger-extension-api` command-line flag exists for Chromium but (a) requires the user to launch Chrome with the flag, (b) is not enabled by default in stable channels, and (c) is not something we can enforce on end users.
- Chrome 126+ added `chrome.debugger.attach` acceptance via `targetId` / `tabId` but did not add a silent-mode option.
- Closing the infobar does not detach the debugger; it is purely informational.

### Decision

Accept the infobar. The TDD already concluded this; Phase 2 confirms no public API exists to suppress it. End-user messaging in the Mac app popup should explain that the banner is expected and normal when Vellum is driving the browser.

### Alternatives considered

- Playwright / `chrome --remote-debugging-port` in a sacrificial profile avoids the infobar but requires installing Chromium and is out-of-scope (Phase 5).
- Chrome 146+ `chrome://inspect` attach backend may offer a less intrusive UX and is being tracked for Phase 4.
