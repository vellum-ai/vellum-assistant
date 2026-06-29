import { z } from "zod";

import { on } from "./ipc";

/**
 * Active assistant display name (e.g. "Aria"), published by the renderer
 * over the `vellum:identity:name` channel.
 *
 * The renderer holds the identity — fetched from the daemon `/identity`
 * endpoint into `useAssistantIdentityStore` — and is the source of truth;
 * main owns only presentation. Subscribers apply the name to the surfaces a
 * per-assistant identity can drive at runtime: the main window's title (which
 * feeds the Window menu, the Cmd-` switcher, and Mission Control), the
 * menu-bar (Tray) tooltip / header line, and the native About panel's
 * application name. The Dock tile / Cmd-Tab label is deliberately NOT one of
 * them — that comes from the bundle's `CFBundleName`, read once at launch.
 *
 * A blank name resets to `null` so those surfaces fall back to their defaults
 * before the renderer has published an identity (or after it clears on
 * sign-out / assistant switch).
 */

type NameListener = (name: string | null) => void;

let currentName: string | null = null;
const listeners = new Set<NameListener>();

export const getName = (): string | null => currentName;

/**
 * Subscribe to name changes. Returns an unsubscribe function. The listener
 * fires only on an actual change (the setter de-dupes), so a renderer that
 * republishes the same name on every render doesn't thrash the title / tray.
 */
export const onNameChange = (listener: NameListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Update the published name and notify subscribers. Blank / whitespace-only
 * values normalize to `null` (fall back to defaults). No-op when unchanged.
 */
export const setName = (name: string | null): void => {
  const next = name?.trim() ? name.trim() : null;
  if (next === currentName) return;
  currentName = next;
  for (const listener of listeners) listener(next);
};

const namePayloadSchema = z.tuple([z.string()]);

/**
 * Register the `vellum:identity:name` renderer→main channel. Fire-and-forget
 * (`ipcRenderer.send`): a name republish has no return value, and a malformed
 * payload should drop silently rather than surface in the renderer. Call once
 * from `whenReady`, before the tray / main window / About install so their
 * initial render can read any name already published during bootstrap.
 */
let installed = false;
export const installIdentityIpc = (): void => {
  if (installed) return;
  installed = true;

  on("vellum:identity:name", namePayloadSchema, ([name]) => {
    setName(name);
  });
};

// Test seam — exported only for unit-test setup so each test starts from a
// known state. Production code never calls this.
export const __resetForTesting = (): void => {
  installed = false;
  currentName = null;
  listeners.clear();
};
