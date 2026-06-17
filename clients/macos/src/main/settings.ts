import Store, { type Schema } from "electron-store";

/**
 * Persisted user preferences shape. The schema below validates writes; reads
 * are returned as `null` when a key has never been written and no default
 * applies. Top-level keys are the renderer-facing categories;
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
  launchAtLogin: boolean;
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
  launchAtLogin: {
    type: "boolean",
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
 * the IPC channel marshals cleanly across the contextBridge. Keyed on
 * `keyof AppSettings` so the return type is the stored value's type and
 * callers no longer have to re-cast.
 */
export const readSetting = <K extends keyof AppSettings>(
  key: K,
): AppSettings[K] | null => {
  const value = store().get(key);
  return value === undefined ? null : value;
};

/**
 * Write a setting. electron-store validates the value against the schema and
 * throws `SyntaxError` (with the ajv error message) when invalid. Keyed on
 * `keyof AppSettings` with a value typed to that key, so an out-of-shape write
 * is caught at compile time rather than relying on the runtime schema alone.
 */
export const writeSetting = <K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): void => {
  store().set(key, value);
};

/**
 * Read the user's override for a single hotkey command, or `null` when none is
 * set. An explicit empty string is a real value — it means the user disabled
 * the binding — and is returned as-is; only an absent key yields `null`, in
 * which case the caller falls back to the compiled default. Shared by
 * `commands.ts` (menu accelerators) and `global-shortcuts.ts` (system-wide
 * shortcuts) so the override-resolution rule lives in one place.
 */
export const readHotkeyOverride = (key: string): string | null => {
  const override = readSetting("hotkeys")?.[key];
  return typeof override === "string" ? override : null;
};

/**
 * Subscribe to changes on a specific settings key. Fires when the value
 * changes (deep equality check by electron-store). Returns an unsubscribe
 * function.
 */
export const onSettingChange = <K extends keyof AppSettings>(
  key: K,
  callback: (newValue: AppSettings[K], oldValue: AppSettings[K]) => void,
): (() => void) => {
  return store().onDidChange(
    key,
    callback as (
      newValue: AppSettings[K] | undefined,
      oldValue: AppSettings[K] | undefined,
    ) => void,
  );
};
