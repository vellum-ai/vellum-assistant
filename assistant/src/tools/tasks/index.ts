/**
 * UX Terminology Glossary
 * ──────────────────────────────────────────────────────────────────────
 *
 * "Task" (user-facing) — A work item in the task queue (backed by the
 *   `work_items` table). This is what users create, run, and track
 *   through conversation.
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

export { executeTaskDelete } from "./task-delete.js";
export { executeTaskList } from "./task-list.js";
export { executeTaskRun } from "./task-run.js";
export { executeTaskSave } from "./task-save.js";
export { executeTaskListAdd } from "./work-item-enqueue.js";
export { executeTaskListShow } from "./work-item-list.js";
export { executeTaskListRemove } from "./work-item-remove.js";
export { executeTaskListUpdate } from "./work-item-update.js";
