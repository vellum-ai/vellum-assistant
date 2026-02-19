/**
 * UX Terminology Glossary
 * ──────────────────────────────────────────────────────────────────────
 *
 * "Task" (user-facing) — A work item in the Tasks panel (backed by the
 *   `work_items` table). This is what users see, create, run, and track.
 *   The user-facing surface is simply called "Tasks".
 *
 * "Task template" / "task definition" (internal) — A reusable template
 *   saved from a conversation (backed by the `tasks` table). Templates
 *   define the prompt pattern and input schema; each run of a template
 *   produces a work item. The tools below (task_save, task_list, etc.)
 *   operate on these internal templates.
 *
 * When writing user-facing copy, prefer "Tasks" (meaning the work queue)
 * over "task list" or "saved tasks". Reserve "task template" for internal
 * comments, logs, and developer-facing docs.
 */

export { executeTaskSave } from './task-save.js';
export { executeTaskRun } from './task-run.js';
export { executeTaskList } from './task-list.js';
export { executeTaskDelete } from './task-delete.js';
export { executeTaskListShow } from './work-item-list.js';
export { executeTaskListAdd } from './work-item-enqueue.js';
export { executeTaskListUpdate } from './work-item-update.js';
export { executeTaskListRemove } from './work-item-remove.js';
