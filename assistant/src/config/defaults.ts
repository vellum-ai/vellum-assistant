import { AssistantConfigSchema } from './schema.js';
import type { AssistantConfig } from './types.js';

// Single source of truth: Zod schema field-level .default() values.
// Parsing an empty object applies every default, so this object always
// matches the schema and cannot drift.
export const DEFAULT_CONFIG: AssistantConfig = AssistantConfigSchema.parse({});
