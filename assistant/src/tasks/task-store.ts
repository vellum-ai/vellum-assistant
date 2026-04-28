import { desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../memory/db-connection.js";
import { taskRuns, tasks, workItems } from "../memory/schema.js";

// ── Types ────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  template: string;
  inputSchema: string | null;
  contextFlags: string | null;
  requiredTools: string | null;
  createdFromConversationId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRun {
  id: string;
  taskId: string;
  conversationId: string | null;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  principalId: string | null;
  memoryScopeId: string | null;
  createdAt: number;
}

// ── Task CRUD ────────────────────────────────────────────────────────

export function createTask(opts: {
  title: string;
  template: string;
  inputSchema?: object;
  contextFlags?: string[];
  requiredTools?: string[];
  createdFromConversationId?: string;
}): Task {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const task: Task = {
    id,
    title: opts.title,
    template: opts.template,
    inputSchema: opts.inputSchema ? JSON.stringify(opts.inputSchema) : null,
    contextFlags: opts.contextFlags ? JSON.stringify(opts.contextFlags) : null,
    requiredTools: opts.requiredTools
      ? JSON.stringify(opts.requiredTools)
      : null,
    createdFromConversationId: opts.createdFromConversationId ?? null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  db.insert(tasks).values(task).run();
  return task;
}

export function getTask(id: string): Task | undefined {
  const db = getDb();
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export function listTasks(): Task[] {
  const db = getDb();
  return db.select().from(tasks).orderBy(desc(tasks.createdAt)).all();
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const existing = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) return false;
  db.delete(workItems).where(eq(workItems.taskId, id)).run();
  db.delete(taskRuns).where(eq(taskRuns.taskId, id)).run();
  db.delete(tasks).where(eq(tasks.id, id)).run();
  return true;
}

export function deleteTasks(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const existing = db.select().from(tasks).where(inArray(tasks.id, ids)).all();
  if (existing.length === 0) return 0;
  const foundIds = existing.map((t) => t.id);
  db.delete(workItems).where(inArray(workItems.taskId, foundIds)).run();
  db.delete(taskRuns).where(inArray(taskRuns.taskId, foundIds)).run();
  db.delete(tasks).where(inArray(tasks.id, foundIds)).run();
  return existing.length;
}

// ── TaskRun CRUD ─────────────────────────────────────────────────────

export function createTaskRun(taskId: string): TaskRun {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  const run: TaskRun = {
    id,
    taskId,
    conversationId: null,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    error: null,
    principalId: null,
    memoryScopeId: null,
    createdAt: now,
  };
  db.insert(taskRuns).values(run).run();
  return run;
}

export function updateTaskRun(
  id: string,
  updates: Partial<
    Pick<
      TaskRun,
      | "status"
      | "conversationId"
      | "error"
      | "principalId"
      | "memoryScopeId"
      | "startedAt"
      | "finishedAt"
    >
  >,
): void {
  const db = getDb();
  db.update(taskRuns).set(updates).where(eq(taskRuns.id, id)).run();
}

export function getTaskRun(id: string): TaskRun | undefined {
  const db = getDb();
  return db.select().from(taskRuns).where(eq(taskRuns.id, id)).get();
}

// ── Brief Helpers ─────────────────────────────────────────────────────

/**
 * Lightweight read-only projection of a work item used by the brief compiler.
 * Avoids pulling the full WorkItem type with all its tool/approval fields.
 */
export interface ActionableWorkItem {
  id: string;
  taskId: string;
  title: string;
  status: string;
  priorityTier: number;
  updatedAt: number;
}
