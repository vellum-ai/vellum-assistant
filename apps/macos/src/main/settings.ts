import Store, { type Schema } from "electron-store";

/**
 * Persisted user preferences shape. The schema below validates writes; reads
 * are returned as `null` when a key has never been written and no default
 * applies. Top-level keys are the renderer-facing categories from LUM-1846 —
 * additional categories get added here as future tickets need them, with a
 * matching schema entry to keep validation honest.
 *
 * Note: window geometry (position, size) is intentionally NOT here. It's a
 * main-process-managed concern in Electron (system-managed on iOS,
 * browser-managed on web), and the renderer never reads or writes it.
 * The persistence for that lives in `./window-state.ts`, which uses its
 * own `electron-store` instance keyed by window kind so it doesn't have
 * to share this file's strict schema.
 */
export interface AppSettings {
  hotkeys: Record<string, string>;
  theme: "light" | "dark" | "system";
  featureFlags: Record<string, boolean>;
}

const schema: Schema<AppSettings> = {
  hotkeys: {
    type: "object",
    additionalProperties: { type: "string" },
    default: {},
  },
  theme: {
    type: "string",
    enum: ["light", "dark", "system"],
    default: "system",
  },
  featureFlags: {
    type: "object",
    additionalProperties: { type: "boolean" },
    default: {},
  },
};

let instance: Store<AppSettings> | null = null;

const store = (): Store<AppSettings> => {
  if (!instance) {
    instance = new Store<AppSettings>({
      schema,
      // Close the root so a renderer typo (e.g. `set("them", "dark")`) is
      // rejected at validation time instead of silently persisted as an
      // unknown top-level key. Per-key shapes are still validated by `schema`.
      rootSchema: { additionalProperties: false },
    });
  }
  return instance;
};

/**
 * Read a setting. Returns `null` (not `undefined`) when the key is absent so
 * the IPC channel marshals cleanly across the contextBridge.
 */
export const readSetting = (key: string): unknown => {
  const value = store().get(key as keyof AppSettings);
  return value === undefined ? null : value;
};

/**
 * Write a setting. electron-store validates the value against the schema and
 * throws `SyntaxError` (with the ajv error message) when invalid; that
 * surfaces to the renderer as a rejected Promise from `window.vellum.settings.set`.
 */
export const writeSetting = (key: string, value: unknown): void => {
  store().set(key as keyof AppSettings, value as never);
};
