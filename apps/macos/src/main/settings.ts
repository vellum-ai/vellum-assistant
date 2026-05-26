import Store, { type Schema } from "electron-store";

/**
 * Persisted user preferences shape. The schema below validates writes; reads
 * are returned as `null` when a key has never been written and no default
 * applies. Top-level keys are the four named categories from LUM-1846 —
 * additional categories get added here as future tickets need them, with a
 * matching schema entry to keep validation honest.
 */
export interface AppSettings {
  hotkeys: Record<string, string>;
  theme: "light" | "dark" | "system";
  windowState: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
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
  windowState: {
    type: "object",
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
    },
    additionalProperties: false,
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
    instance = new Store<AppSettings>({ schema });
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
