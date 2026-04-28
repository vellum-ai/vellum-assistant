/** Shared types for the skill IPC layer (skill-server + skill-routes). */

/** Handler shape for skill IPC routes — receives flat params + connection. */
export type SkillMethodHandler = (
  params?: Record<string, unknown>,
  connection?: unknown,
) => unknown | Promise<unknown>;

/** A single skill IPC route — method name + handler. */
export type SkillIpcRoute = {
  method: string;
  handler: SkillMethodHandler;
};
