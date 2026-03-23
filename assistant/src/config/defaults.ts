import { applyNestedDefaults } from "./loader.js";
import type { AssistantConfig } from "./types.js";

// Single source of truth: Zod schema field-level .default() values.
export const DEFAULT_CONFIG: AssistantConfig = applyNestedDefaults({});
