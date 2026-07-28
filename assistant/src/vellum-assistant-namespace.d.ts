/**
 * The single shape of `globalThis.vellumAssistant` — the per-process namespace
 * that holds the assistant's process-global singletons.
 *
 * Several modules keep process-global state on `globalThis.vellumAssistant.*`
 * (see the slots below). Each such slot is read/written by a production module
 * AND, independently, by a test helper in `src/__tests__/` that must NOT import
 * that production module (importing it would run its load-time side effects
 * before the test preload establishes the per-process workspace override — the
 * coupling behind the May 2026 DB-ghost incidents). This file is how both sides
 * agree on the shape without a runtime import between them.
 *
 * It is an **ambient** declaration (no top-level `import`/`export`), so
 * `VellumAssistantNamespace`, the slot types, and the `vellumAssistant` binding
 * are global — every module and test helper refers to them by name with zero
 * imports, and nothing here reaches into a `src/` module even at the type
 * level. Referring to these types therefore never adds anything to any file's
 * runtime import graph, so the test-machinery isolation invariant holds.
 *
 * Adding a slot: declare its value type here, add the optional property to
 * `VellumAssistantNamespace`, and have the owning module + its test helper
 * reference these globals instead of declaring their own copies.
 */

/** Slot value: the encrypted credential store path override. Managed by `security/store-path-override.ts`. */
interface VellumStorePathOverride {
  storePath: string | null;
  storeKeyPath: string | null;
}

/** Which assistant DB connection a singleton slot holds. */
type VellumDbSlotKey =
  | "main"
  | "main-readonly"
  | "logs"
  | "memory"
  | "telemetry";

/**
 * Slot value: one lazily-opened DB connection and the closer that drops it.
 * `db` is `unknown` so this shape never has to name a Drizzle type; callers in
 * `persistence/db-connection.ts` narrow it via `getStoredDb<T>()`.
 */
interface VellumDbSlot {
  db: unknown;
  closer: (() => void) | null;
}

/** Slot value: the assistant DB connection singletons, keyed by connection. Managed by `persistence/db-singleton.ts`. */
type VellumDbSlots = Record<VellumDbSlotKey, VellumDbSlot>;

/** Slot value: the resolved feature-flag override cache. Managed by `config/feature-flag-cache.ts`. */
interface VellumFeatureFlagCache {
  overrides: Record<string, boolean | string> | null;
  fromGateway: boolean;
}

/** The per-process `globalThis.vellumAssistant` namespace. */
interface VellumAssistantNamespace {
  /**
   * Whether this OS process is the main assistant daemon. Set once by the
   * daemon entrypoint; absent elsewhere. See `runtime/process-role.ts`.
   */
  mainDaemonProcess?: boolean;
  /** See `security/store-path-override.ts`. */
  storePathOverride?: VellumStorePathOverride;
  /** See `persistence/db-singleton.ts`. */
  dbSingletons?: VellumDbSlots;
  /** See `config/feature-flag-cache.ts`. */
  featureFlagCache?: VellumFeatureFlagCache;
}

/**
 * Types `globalThis.vellumAssistant`. Undefined until the first slot accessor
 * seeds it (`globalThis.vellumAssistant ??= {}`). Must be `var`: only `var`
 * declarations at global scope become typed properties of `globalThis`
 * (`let`/`const` do not), so this is the one idiomatic way to type the binding.
 */
// eslint-disable-next-line no-var
declare var vellumAssistant: VellumAssistantNamespace | undefined;
