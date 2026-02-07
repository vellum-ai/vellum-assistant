import fs from "fs";
import path from "path";

import { neon } from "@neondatabase/serverless";

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const sql = neon(databaseUrl);

  // Create migrations tracking table if it doesn't exist
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // Get list of migration files
  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  // Get already executed migrations
  const executedMigrations = await sql`SELECT name FROM _migrations`;
  const executedNames = new Set(
    executedMigrations.map((row) => row.name as string)
  );

  // Run pending migrations
  for (const file of migrationFiles) {
    if (executedNames.has(file)) {
      console.log(`Skipping already executed migration: ${file}`);
      continue;
    }

    console.log(`Running migration: ${file}`);
    const migrationPath = path.join(migrationsDir, file);
    const migrationSql = fs.readFileSync(migrationPath, "utf-8");

    const statements = migrationSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const statement of statements) {
      await sql.query(statement);
    }

    await sql`INSERT INTO _migrations (name) VALUES (${file})`;

    console.log(`Completed migration: ${file}`);
  }

  console.log("All migrations completed successfully");
}

runMigrations().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
