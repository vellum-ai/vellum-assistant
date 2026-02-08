import { execSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const args = process.argv.slice(2);
const preview = args.includes("--preview");

const tmpOut = mkdtempSync(join(tmpdir(), "drizzle-migrate-"));

try {
  execSync(
    `npx drizzle-kit generate --dialect postgresql --schema ./src/lib/schema.ts --out ${tmpOut}`,
    { stdio: "pipe" }
  );

  const sqlFiles = readdirSync(tmpOut)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (sqlFiles.length === 0) {
    console.log("No pending schema changes detected.");
    process.exit(0);
  }

  const sql = sqlFiles
    .map((f) => {
      const content = readFileSync(join(tmpOut, f), "utf-8");
      return `-- File: ${f}\n${content}`;
    })
    .join("\n\n");

  if (preview) {
    console.log("-- Preview of SQL to be executed:\n");
    console.log(sql);
  } else {
    console.log("Running migrations...\n");
    execSync("npx drizzle-kit migrate", { stdio: "inherit" });
    console.log("\nMigrations applied successfully.");
  }
} finally {
  rmSync(tmpOut, { recursive: true, force: true });
}
