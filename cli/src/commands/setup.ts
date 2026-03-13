import { createInterface } from "readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

function getVellumDir(): string {
  const base = process.env.BASE_DATA_DIR?.trim() || homedir();
  return join(base, ".vellum");
}

function getEnvFilePath(): string {
  return join(getVellumDir(), ".env");
}

function readEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath();
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars[key] = value;
  }
  return vars;
}

function writeEnvFile(vars: Record<string, string>): void {
  const envPath = getEnvFilePath();
  const dir = dirname(envPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
}

async function promptMasked(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echoing by writing the prompt manually and intercepting keystrokes
    process.stdout.write(prompt);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let input = "";
    const onData = (key: Buffer): void => {
      const char = key.toString("utf-8");

      if (char === "\r" || char === "\n") {
        // Enter pressed
        stdin.removeListener("data", onData);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        process.stdout.write("\n");
        rl.close();
        resolve(input);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007F" || char === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (char.length === 1 && char >= " ") {
        input += char;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function setup(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum setup");
    console.log("");
    console.log("Interactive wizard to configure API keys.");
    console.log(
      "Keys are validated against their APIs and saved to <BASE_DATA_DIR>/.vellum/.env.",
    );
    process.exit(0);
  }

  console.log("Vellum Setup");
  console.log("============\n");

  const existingVars = readEnvFile();
  const hasExistingKey = !!existingVars.ANTHROPIC_API_KEY;

  if (hasExistingKey) {
    const masked =
      existingVars.ANTHROPIC_API_KEY.slice(0, 7) +
      "..." +
      existingVars.ANTHROPIC_API_KEY.slice(-4);
    console.log(`Anthropic API key is already configured (${masked}).`);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("Overwrite? [y/N] ", resolve);
    });
    rl.close();

    if (answer.trim().toLowerCase() !== "y") {
      console.log("\nSetup complete. No changes made.");
      return;
    }
    console.log("");
  }

  const apiKey = await promptMasked(
    "Enter your Anthropic API key (sk-ant-...): ",
  );

  if (!apiKey.trim()) {
    console.error("Error: API key cannot be empty.");
    process.exit(1);
  }

  console.log("Validating key...");
  const valid = await validateAnthropicKey(apiKey.trim());

  if (!valid) {
    console.error(
      "Error: Invalid API key. Could not authenticate with the Anthropic API.",
    );
    process.exit(1);
  }

  existingVars.ANTHROPIC_API_KEY = apiKey.trim();
  writeEnvFile(existingVars);

  console.log(`\nAPI key saved to ${getEnvFilePath()}`);
  console.log("Setup complete.");
}
