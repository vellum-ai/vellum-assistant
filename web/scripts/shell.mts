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

const { assistantsTable, chatMessagesTable, usersTable, apiKeysTable } = schema;

console.log("\nVellum Shell");
console.log("─".repeat(40));
console.log("Globals:");
console.log("  db                 Drizzle database client");
console.log("  schema             All schema tables");
console.log("  assistantsTable, chatMessagesTable, usersTable, apiKeysTable");
console.log("  eq, and, or, not, gt, gte, lt, lte,");
console.log("  like, ilike, inArray, sql");
console.log("");
console.log("Example:");
console.log("  await db.select().from(usersTable)");
console.log("");

const r = repl.start({
  prompt: "vel> ",
});

Object.assign(r.context, {
  db,
  schema,
  assistantsTable,
  chatMessagesTable,
  usersTable,
  apiKeysTable,
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

Object.defineProperty(r.context, "exit", {
  get() {
    r.close();
  },
});

r.on("exit", async () => {
  await client.end();
  process.exit(0);
});
