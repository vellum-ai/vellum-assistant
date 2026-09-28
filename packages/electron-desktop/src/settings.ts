import Store, { type Options, type Schema } from "electron-store";

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
 * The shared window-state module uses its own `electron-store` instance keyed
 * by window kind so it doesn't have to share this file's strict schema.
 */
export interface AppSettings {
  hotkeys: Record<string, string>;
  theme: "light" | "dark" | "system";
  featureFlags: Record<string, boolean>;
  launchAtLogin: boolean;
  shareDiagnostics: boolean;
  suppressRelocationPrompt: boolean;
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
  shareDiagnostics: {
    type: "boolean",
  },
  suppressRelocationPrompt: {
    type: "boolean",
  },
};

let instance: Store<AppSettings> | null = null;

export const createAppSettingsStore = (
  options: Pick<Options<AppSettings>, "cwd" | "name"> = {},
): Store<AppSettings> =>
  new Store<AppSettings>({
    ...options,
    schema,
    clearInvalidConfig: true,
    rootSchema: { additionalProperties: false },
  });

const store = (): Store<AppSettings> => {
  if (!instance) {
    instance = createAppSettingsStore();
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
