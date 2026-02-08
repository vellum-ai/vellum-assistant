import repl from "node:repl";
import { and, eq, gt, gte, ilike, inArray, like, lt, lte, not, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../src/lib/schema";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://vellum:password@localhost:5432/vellum";
const client = postgres(connectionString);
const db = drizzle(client, { schema });

console.log("\nVellum Shell");
console.log("─".repeat(40));
console.log("Globals:");
console.log("  db            Drizzle database client");
console.log("  schema        All schema tables");
console.log("  users, assistants, chatMessages, apiKeys");
console.log("  eq, and, or, not, gt, gte, lt, lte,");
console.log("  like, ilike, inArray, sql");
console.log("");
console.log("Example:");
console.log("  await db.select().from(users)");
console.log("");

const r = repl.start({
  prompt: "vel> ",
});

Object.assign(r.context, {
  db,
  schema,
  ...schema,
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  like,
  lt,
  lte,
  not,
  or,
  sql,
});

r.on("exit", async () => {
  await client.end();
  process.exit(0);
});
