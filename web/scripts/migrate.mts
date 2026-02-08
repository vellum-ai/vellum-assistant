import { execSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const drizzleDir = join(process.cwd(), "drizzle");

function generateToTmpDir(): string[] {
  const tmpOut = mkdtempSync(join(tmpdir(), "drizzle-migrate-"));
  try {
    if (existsSync(drizzleDir)) {
      cpSync(drizzleDir, tmpOut, { recursive: true });
    }

    const before = new Set(readdirSync(tmpOut).filter((f) => f.endsWith(".sql")));

    execSync(
      `npx drizzle-kit generate --dialect postgresql --schema ./src/lib/schema.ts --out ${tmpOut}`,
      { stdio: "pipe" }
    );

    const after = readdirSync(tmpOut).filter((f) => f.endsWith(".sql"));
    const newFiles = after.filter((f) => !before.has(f)).sort();

    return newFiles.map((f) => {
      const content = readFileSync(join(tmpOut, f), "utf-8");
      return `-- ${f}\n${content}`;
    });
  } finally {
    rmSync(tmpOut, { recursive: true, force: true });
  }
}

const sqlStatements = generateToTmpDir();

if (sqlStatements.length === 0) {
  console.log("No pending schema changes detected.");
  process.exit(0);
}

const sql = sqlStatements.join("\n\n");

if (preview) {
  console.log("-- Preview of SQL to be generated:\n");
  console.log(sql);
} else {
  execSync("npx drizzle-kit generate", { stdio: "inherit" });
  console.log("\nRunning migrations...\n");
  execSync("npx drizzle-kit migrate", { stdio: "inherit" });
  console.log("\nMigrations applied successfully.");
}
