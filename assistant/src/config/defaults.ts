import { applyNestedDefaults } from './loader.js';
import type { AssistantConfig } from './types.js';

// Single source of truth: Zod schema field-level .default() values.
// Uses applyNestedDefaults to cascade through nested .default({}) calls,
// which Zod 4 doesn't resolve in a single parse pass.
export const DEFAULT_CONFIG: AssistantConfig = applyNestedDefaults({});
