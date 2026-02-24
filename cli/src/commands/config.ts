import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface AllowlistConfig {
  values?: string[];
  prefixes?: string[];
  patterns?: string[];
}

interface AllowlistValidationError {
  index: number;
  pattern: string;
  message: string;
}

function getRootDir(): string {
  return join(process.env.BASE_DATA_DIR?.trim() || homedir(), ".vellum");
}

function getConfigPath(): string {
  return join(getRootDir(), "workspace", "config.json");
}

function getAllowlistPath(): string {
  return join(getRootDir(), "protected", "secret-allowlist.json");
}

function loadRawConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function saveRawConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (
      current[key] === undefined ||
      current[key] === null ||
      typeof current[key] !== "object"
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function validateAllowlist(
  allowlistConfig: AllowlistConfig,
): AllowlistValidationError[] {
  const errors: AllowlistValidationError[] = [];
  if (!allowlistConfig.patterns) return errors;
  if (!Array.isArray(allowlistConfig.patterns)) {
    errors.push({
      index: -1,
      pattern: String(allowlistConfig.patterns),
      message: '"patterns" must be an array',
    });
    return errors;
  }

  for (let i = 0; i < allowlistConfig.patterns.length; i++) {
    const p = allowlistConfig.patterns[i];
    if (typeof p !== "string") {
      errors.push({
        index: i,
        pattern: String(p),
        message: "Pattern is not a string",
      });
      continue;
    }
    try {
      new RegExp(p);
    } catch (err) {
      errors.push({
        index: i,
        pattern: p,
        message: (err as Error).message,
      });
    }
  }
  return errors;
}

function validateAllowlistFile(): AllowlistValidationError[] | null {
  const filePath = getAllowlistPath();
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const allowlistConfig: AllowlistConfig = JSON.parse(
    raw,
  ) as AllowlistConfig;
  return validateAllowlist(allowlistConfig);
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

export function config(): void {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error("Usage: vellum config set <key> <value>");
        process.exit(1);
      }
      const raw = loadRawConfig();
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        // keep as string
      }
      setNestedValue(raw, key, parsed);
      saveRawConfig(raw);
      console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
      break;
    }

    case "get": {
      const key = args[1];
      if (!key) {
        console.error("Usage: vellum config get <key>");
        process.exit(1);
      }
      const raw = loadRawConfig();
      const val = getNestedValue(raw, key);
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
      const raw = loadRawConfig();
      if (Object.keys(raw).length === 0) {
        console.log("No configuration set");
      } else {
        console.log(JSON.stringify(raw, null, 2));
      }
      break;
    }

    case "validate-allowlist": {
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
