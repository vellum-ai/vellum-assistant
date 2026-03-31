#!/usr/bin/env bun
import { initializeDb } from "../db-init.js";
import { getMemoryCheckpoint } from "../checkpoints.js";
import { getDb } from "../db.js";
import { conversations } from "../schema.js";
import { asc } from "drizzle-orm";
import { countNodes } from "./store.js";
import { memoryGraphEdges, memoryGraphTriggers } from "../schema.js";
import { sql } from "drizzle-orm";

initializeDb();
const db = getDb();
const all = db
  .select({ id: conversations.id })
  .from(conversations)
  .orderBy(asc(conversations.createdAt))
  .all();
const lastId = getMemoryCheckpoint("graph_bootstrap:last_conversation_id");
const lastIdx = lastId ? all.findIndex((c) => c.id === lastId) : -1;
const done = lastIdx + 1;
const nodes = countNodes("default");
const edges =
  db
    .select({ count: sql<number>`count(*)` })
    .from(memoryGraphEdges)
    .get()?.count ?? 0;
const triggers =
  db
    .select({ count: sql<number>`count(*)` })
    .from(memoryGraphTriggers)
    .get()?.count ?? 0;
const pct = ((done / all.length) * 100).toFixed(1);

console.log(
  `${done}/${all.length} conversations (${pct}%) · ${nodes} nodes · ${edges} edges · ${triggers} triggers`,
);
