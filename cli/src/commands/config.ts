import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ConfigLoader {
  loadRawConfig: () => Record<string, unknown>;
  saveRawConfig: (config: Record<string, unknown>) => void;
  getNestedValue: (obj: Record<string, unknown>, path: string) => unknown;
  setNestedValue: (
    obj: Record<string, unknown>,
    path: string,
    value: unknown,
  ) => void;
}

interface AllowlistValidationError {
  index: number;
  pattern: string;
  message: string;
}

interface SecretAllowlist {
  validateAllowlistFile: () => AllowlistValidationError[] | null;
}

function resolveAssistantSrcDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@vellumai/assistant/package.json");
    return join(dirname(pkgPath), "src");
  } catch {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const localPath = join(__dirname, "..", "..", "assistant", "src");
    if (existsSync(localPath)) {
      return localPath;
    }
  }
  return undefined;
}

function printUsage(): void {
  console.log("Usage: vellum config <subcommand> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  get <key>              Get a config value (supports dotted paths)",
  );
  console.log(
    "  set <key> <value>      Set a config value (supports dotted paths like apiKeys.anthropic)",
  );
  console.log(
    "  list                   List all config values",
  );
  console.log(
    "  validate-allowlist     Validate regex patterns in secret-allowlist.json",
  );
}

export async function config(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  const assistantSrc = resolveAssistantSrcDir();
  if (!assistantSrc) {
    console.error(
      "Error: Could not resolve assistant package. Install the full stack with: bun install -g vellum",
    );
    process.exit(1);
  }

  // Dynamic imports are required here because the assistant package path is
  // resolved at runtime — it may be a sibling directory or a global install.
  const loader = (await import(
    join(assistantSrc, "config", "loader.ts")
  )) as ConfigLoader;

  switch (subcommand) {
    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error("Usage: vellum config set <key> <value>");
        process.exit(1);
      }
      const raw = loader.loadRawConfig();
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        // keep as string
      }
      loader.setNestedValue(raw, key, parsed);
      loader.saveRawConfig(raw);
      console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
      break;
    }

    case "get": {
      const key = args[1];
      if (!key) {
        console.error("Usage: vellum config get <key>");
        process.exit(1);
      }
      const raw = loader.loadRawConfig();
      const val = loader.getNestedValue(raw, key);
      if (val === undefined) {
        console.log("(not set)");
      } else {
        console.log(
          typeof val === "object" ? JSON.stringify(val, null, 2) : String(val),
        );
      }
      break;
    }

    case "list": {
      const raw = loader.loadRawConfig();
      if (Object.keys(raw).length === 0) {
        console.log("No configuration set");
      } else {
        console.log(JSON.stringify(raw, null, 2));
      }
      break;
    }

    case "validate-allowlist": {
      // Dynamic import: only loaded for this subcommand since it pulls in
      // additional assistant dependencies not needed by get/set/list.
      const { validateAllowlistFile } = (await import(
        join(assistantSrc, "security", "secret-allowlist.ts")
      )) as SecretAllowlist;
      try {
        const errors = validateAllowlistFile();
        if (errors === null) {
          console.log("No secret-allowlist.json file found");
          return;
        }
        if (errors.length === 0) {
          console.log("All patterns in secret-allowlist.json are valid");
          return;
        }
        console.error(
          `Found ${errors.length} invalid pattern(s) in secret-allowlist.json:`,
        );
        for (const e of errors) {
          console.error(`  [${e.index}] "${e.pattern}": ${e.message}`);
        }
        process.exit(1);
      } catch (err) {
        console.error(
          `Failed to read secret-allowlist.json: ${(err as Error).message}`,
        );
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Unknown config subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
    }
  }
}
