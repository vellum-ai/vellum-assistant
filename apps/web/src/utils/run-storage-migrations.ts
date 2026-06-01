/**
 * Side-effect module: runs all localStorage migrations synchronously at
 * import time.
 *
 * **IMPORTANT** — In `main.tsx`, this import MUST appear before any import
 * that transitively evaluates a Zustand store reading from localStorage
 * (e.g. `routes.tsx` → `onboarding-store`, `client-feature-flag-store`).
 * ES modules evaluate in import-declaration order within a file, so
 * placing this import first guarantees migrations write the new key names
 * before any store's module-level initializer reads them.
 */

import { migrateDeviceSettings } from "./device-settings";
import { runStorageMigrations } from "./storage-migration";

migrateDeviceSettings();
runStorageMigrations();
