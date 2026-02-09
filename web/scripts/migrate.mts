import { execSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const args = process.argv.slice(2);
const preview = args.includes("--preview");

if (preview) {
  const diffDir = mkdtempSync(join(tmpdir(), "drizzle-diff-"));
  try {
    // Generate baseline migration from main branch schema
    const baseSchema = execSync("git show origin/main:web/src/lib/schema.ts", {
      encoding: "utf-8",
    });
    writeFileSync(join(diffDir, "base-schema.ts"), baseSchema);

    execSync(
      `bunx drizzle-kit generate --schema "${join(diffDir, "base-schema.ts")}" --out "${diffDir}" --dialect postgresql`,
      { stdio: "pipe" }
    );
    const baseline = readdirSync(diffDir).filter((f) => f.endsWith(".sql"));

    // Generate diff migration from current PR schema
    execSync(
      `bunx drizzle-kit generate --schema ./src/lib/schema.ts --out "${diffDir}" --dialect postgresql`,
      { stdio: "pipe" }
    );
    const total = readdirSync(diffDir).filter((f) => f.endsWith(".sql"));
    const newFiles = total.filter((f) => !baseline.includes(f)).sort();

    if (newFiles.length > 0) {
      console.log("### Schema changes detected:\n");
      for (const f of newFiles) {
        console.log(readFileSync(join(diffDir, f), "utf-8"));
      }
    } else {
      console.log("No schema changes detected.");
    }
  } finally {
    rmSync(diffDir, { recursive: true, force: true });
  }
} else {
  console.log("Ensuring database exists...\n");
  execSync("bun run scripts/ensure-db.mts", { stdio: "inherit" });
  console.log("\nPushing schema changes to database...\n");
  execSync("bunx drizzle-kit push --force", { stdio: "inherit" });
  console.log("\nSchema push completed successfully.");
}
