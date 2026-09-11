/**
 * Plugin-local re-export of the workspace SKILL.md mtime poll so hook files
 * under `hooks/` do not grow a new escaping specifier. The daemon module is
 * already a memory-plugin baseline import from `startup.ts` / `worker.ts`.
 */
export {
  startWorkspaceSkillMdMtimePoll,
  stopWorkspaceSkillMdMtimePoll,
} from "../../../daemon/skill-memory-refresh.js";
