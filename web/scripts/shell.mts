import { createInterface } from "node:readline";
import { and, eq, gt, gte, ilike, inArray, like, lt, lte, not, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../src/lib/schema";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://vellum:password@localhost:5432/vellum";
const client = postgres(connectionString);
const db = drizzle(client, { schema });

const { assistantsTable, chatMessagesTable, user, apiKeysTable } = schema;

const context: Record<string, unknown> = {
  db,
  schema,
  assistantsTable,
  chatMessagesTable,
  user,
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
};

console.log("\nVellum Shell");
console.log("─".repeat(40));
console.log("Globals:");
console.log("  db                 Drizzle database client");
console.log("  schema             All schema tables");
console.log("  assistantsTable, chatMessagesTable, user, apiKeysTable");
console.log("  eq, and, or, not, gt, gte, lt, lte,");
console.log("  like, ilike, inArray, sql");
console.log("");
console.log("Example:");
console.log("  await db.select().from(user)");
console.log("");

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "vel> ",
});

rl.prompt();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }
  if (trimmed === ".exit" || trimmed === "exit") {
    rl.close();
    return;
  }

  try {
    const asyncFn = new Function(
      ...Object.keys(context),
      `return (async () => { return ${trimmed} })();`
    );
    const result = await asyncFn(...Object.values(context));
    if (result !== undefined) {
      console.dir(result, { depth: null, colors: true });
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
  }

  rl.prompt();
});

rl.on("close", async () => {
  await client.end();
  process.exit(0);
});
