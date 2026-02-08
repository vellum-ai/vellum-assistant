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

const tables = [
  { name: "assistants", table: schema.assistants },
  { name: "chatMessages", table: schema.chatMessages },
  { name: "users", table: schema.users },
  { name: "apiKeys", table: schema.apiKeys },
] as const;

type TableRows = {
  assistants: (typeof schema.assistants.$inferSelect)[];
  chatMessages: (typeof schema.chatMessages.$inferSelect)[];
  users: (typeof schema.users.$inferSelect)[];
  apiKeys: (typeof schema.apiKeys.$inferSelect)[];
};

async function fetchAllTables(): Promise<TableRows> {
  const [assistants, chatMessages, users, apiKeys] = await Promise.all(
    tables.map(({ table }) => db.select().from(table))
  );
  return {
    assistants,
    chatMessages,
    users,
    apiKeys,
  } as TableRows;
}

const rows = await fetchAllTables();

console.log("\nVellum Shell");
console.log("─".repeat(40));
console.log("Globals:");
console.log("  db            Drizzle database client");
console.log("  schema        All schema tables");
console.log("  users, assistants, chatMessages, apiKeys");
console.log("  eq, and, or, not, gt, gte, lt, lte,");
console.log("  like, ilike, inArray, sql");
console.log("");
console.log("Preloaded rows:");
for (const { name } of tables) {
  console.log(`  rows.${name} (${rows[name].length} rows)`);
}
console.log("");
console.log("Example:");
console.log("  await db.select().from(users)");
console.log("  rows.assistants");
console.log("");

const r = repl.start({
  prompt: "vel> ",
});

Object.assign(r.context, {
  db,
  schema,
  ...schema,
  rows,
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

r.defineCommand("reload", {
  help: "Reload all table rows",
  async action() {
    const fresh = await fetchAllTables();
    Object.assign(rows, fresh);
    for (const { name } of tables) {
      console.log(`  rows.${name} (${rows[name].length} rows)`);
    }
    this.displayPrompt();
  },
});

const originalEval = r.eval.bind(r);
r.eval = (cmd, context, filename, callback) => {
  if (cmd.trim() === "exit") {
    r.close();
    return;
  }
  originalEval(cmd, context, filename, callback);
};

r.on("exit", async () => {
  await client.end();
  process.exit(0);
});
