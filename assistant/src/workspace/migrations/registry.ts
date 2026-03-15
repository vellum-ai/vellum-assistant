import type { WorkspaceMigration } from "./types.js";

/**
 * Ordered list of all workspace data migrations.
 * New migrations are appended to the end. Never reorder or remove entries.
 *
 * NOTE: avatarRenameMigration (001-avatar-rename.ts) is intentionally not
 * registered yet. It renames avatar files to new paths, but no consumer code
 * reads from the new filenames. Re-add it here once the avatar-skill-refactor
 * plan updates all consumers to use the new paths.
 */
export const WORKSPACE_MIGRATIONS: WorkspaceMigration[] = [];
