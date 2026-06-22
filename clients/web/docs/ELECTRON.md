# Electron Conventions

The web app ships as both a browser SPA and the renderer of an Electron desktop shell (see [`clients/macos/`](../../../clients/macos/)). The shell exposes a typed bridge to the renderer as `window.vellum`, defined in [`clients/macos/src/preload/index.ts`](../../../clients/macos/src/preload/index.ts) and mirrored as an ambient declaration in [`clients/web/src/runtime/is-electron.ts`](../src/runtime/is-electron.ts).

> **Read this only if your change touches Electron code paths.** For browser-only and iOS-only contributions you can skip this document. Building the Electron app itself additionally requires running `clients/macos/`'s dev scripts; the main-process source lives in [`clients/macos/src/main/`](../../../clients/macos/src/main/).

If you're touching anything in [`clients/web/src/runtime/`](../src/runtime/) that calls `window.vellum.*`, or adding a new bridge surface — start here.

---

## Wrap `window.vellum.*` access in a per-capability `runtime/` module

`window.vellum` is `undefined` on web and Capacitor iOS — the bridge only exists when the renderer is loaded inside the Electron shell. Feature code that reaches into `window.vellum.*` directly crashes off-Electron and forces every call site to repeat an `isElectron()` check.

**The wrappers in [`clients/web/src/runtime/`](../src/runtime/) are the only files in `clients/web/` that touch `window.vellum.*` directly.** Feature code imports the wrapper functions, not the bridge. Pattern, copied from [`native-biometric.ts`](../src/runtime/native-biometric.ts):

```ts
// clients/web/src/runtime/<capability>.ts
import { isElectron } from "@/runtime/is-electron";

export async function setDockBadge(count: number): Promise<void> {
  if (!isElectron()) return;
  await window.vellum?.dock.setBadge(count);
}
```

Two things this buys:

- **No-op off Electron.** Callers don't need an `isElectron()` check at every call site, so the same hook works on web/iOS/Electron.
- **One place to change** if the bridge surface evolves — rename a method, swap the underlying IPC channel — without touching feature code.

This parallels the [Capacitor plugin lazy-import rule](./CAPACITOR.md#capacitor-plugins-must-be-destructured-inline-lazy-import-rule): both keep host-specific globals out of feature modules so the same React tree mounts on every platform.

See [`clients/web/src/runtime/dock.ts`](../src/runtime/dock.ts) and [`clients/web/src/runtime/vellum-commands.ts`](../src/runtime/vellum-commands.ts) for the established shape.

---

## When a capability has a real web/dev implementation, the wrapper branches instead of no-opping

Most bridges are desktop-only niceties (Dock badge, biometrics) and so the off-Electron branch is a no-op. Some capabilities, though, are first-class on the web/dev host too and have a genuine non-Electron implementation — the wrapper is then a true **transport seam**: it selects the implementation once, and both branches are real.

[`local-mode-host.ts`](../src/runtime/local-mode-host.ts) is the reference. Local-mode provisioning drives the Vellum CLI, which must run in a trusted host process — the Electron main process in the desktop shell, or the Vite dev-server middleware on web/dev. The wrapper is the one place that branch lives:

```ts
// clients/web/src/runtime/local-mode-host.ts
export async function hatchLocalAssistant(species = "vellum") {
  if (isElectron()) return window.vellum!.localMode.hatch(species);
  // web/dev: the Vite middleware spawns the CLI binary
  const res = await fetch("/assistant/__local/hatch", { method: "POST", /* … */ });
  return res.json();
}
```

The rules are otherwise identical to the no-op wrappers: feature code imports the named function and never sees the branch, and the wrapper is the only renderer file that touches `window.vellum.localMode`. The only difference is that the non-Electron path returns a real result rather than `undefined`/no-op, so both hosts honor the same contract.

---

## Hooks that bridge feature state to the Electron host live in the domain, not in `runtime/`

The `runtime/` wrappers expose **imperative functions** (`setDockBadge(count)`, `useVellumCommands(handlers)`). When a feature needs to publish state changes to the host on every tick (e.g. unread count → Dock badge), the React hook that does that **lives in the domain that owns the source data**, not in the runtime layer.

```
clients/web/src/runtime/dock.ts                              ← imperative bridge
clients/web/src/domains/chat/hooks/use-electron-dock-sync.ts ← domain hook
```

The chat domain knows what counts as "unread" (see [`utils/conversation-predicates.ts`](../src/utils/conversation-predicates.ts)); only the chat domain should decide when to call the bridge. Putting the hook in `runtime/` would invert that — the runtime layer would need to import domain types and predicates, which couples the platform-shim to feature semantics.

See [`clients/web/src/domains/chat/hooks/use-electron-dock-sync.ts`](../src/domains/chat/hooks/use-electron-dock-sync.ts).

---

## Adding a new bridge surface

When extending `window.vellum.*`, three files change together because the three TypeScript projects (main, preload, renderer) don't share a workspace symbol table:

1. **[`clients/macos/src/preload/index.ts`](../../../clients/macos/src/preload/index.ts)** — adds the IPC plumbing + the typed `VellumBridge` field.
2. **[`clients/web/src/runtime/is-electron.ts`](../src/runtime/is-electron.ts)** — mirrors the new field on the renderer-side ambient `Window.vellum?` declaration.
3. **`clients/web/src/runtime/<capability>.ts`** — per-capability wrapper module exposing the no-op-off-Electron functions feature code calls.

The main-process handler itself lives in `clients/macos/src/main/`; that's a main-process concern, not a renderer one. For main-process conventions see [`clients/macos/README.md`](../../../clients/macos/README.md).

---

## Cross-domain push signals route through the event bus, not directly via the bridge

The runtime wrapper is the surface for **imperative** access (`setDockBadge(count)`, `getAppVersionInfo()`). For **push signals** — main-process events that multiple renderer domains care about — the wrapper publishes into the [event bus](./EVENT_BUS.md), and consumers subscribe via the bus.

Example (`runtime/power-events.ts` + `BusEventMap`): the system's `powerMonitor` fires `suspend` / `resume` / `lock` / `unlock` / `active`. Multiple renderer subsystems care (SSE reconnect, future auth-refresh on wake, future reachability probe). The right shape is:

1. `clients/macos/src/main/power-events.ts` — subscribes to `powerMonitor`, broadcasts to all renderers via `webContents.send`.
2. `clients/macos/src/preload/index.ts` — `window.vellum.power.onEvent(callback) → unsubscribe`.
3. `clients/web/src/runtime/power-events.ts` — `subscribeToPowerEvents(callback)` (the no-op-off-Electron wrapper).
4. `clients/web/src/hooks/use-event-bus-init.ts` — calls the wrapper once at mount, fans events in as `power.suspend` / `power.resume` / etc. on the bus.
5. Domain consumers subscribe to `bus.subscribe("power.resume", ...)` — never to the wrapper directly.

The bus integration means the same subscriber code works whether the signal came from `powerMonitor` (Electron), `visibilitychange` (web), or Capacitor `appStateChange` (iOS). Wrappers that publish into the bus stay tiny — they're just signal sources.

### When signals can arrive before the renderer exists

A subset of push signals — inbound deep links being the canonical case — can arrive at the main process BEFORE the renderer has loaded (the OS launches the app via a `vellum://` click → `open-url` fires before `whenReady`). The renderer wrapper grows a second surface for these:

- **`subscribe<X>(callback)`** — live subscription for post-mount signals.
- **`drainPending<X>()`** — returns and clears the main-side buffer of signals that arrived during startup.

`use-event-bus-init` calls `subscribe` BEFORE `drainPending` so a signal arriving in flight between the two calls isn't lost. Example: `clients/web/src/runtime/deep-links.ts` paired with the main-side buffer in `clients/macos/src/main/deep-links.ts`.

---

## See also

- [`CONVENTIONS.md`](./CONVENTIONS.md) — architecture, code organization, component patterns.
- [`CAPACITOR.md`](./CAPACITOR.md) — Capacitor / iOS patterns (parallel host).
- [`clients/macos/README.md`](../../../clients/macos/README.md) — Electron shell setup, dev scripts, main-process source layout.
