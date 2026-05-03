import { createInterface } from "readline";

import { resolveAssistant } from "../lib/assistant-config.js";

async function promptMasked(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

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
        stdin.removeListener("data", onData);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw ?? false);
        }
        process.stdout.write("\n");
        rl.close();
        resolve(input);
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007F" || char === "\b") {
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
      "Injects secrets into your running assistant via the gateway API.",
    );
    process.exit(0);
  }

  const entry = resolveAssistant();
  if (!entry) {
    console.error(
      "Error: No active assistant found. Run `vellum hatch` first.",
    );
    process.exit(1);
  }

  const gatewayUrl = entry.localUrl ?? entry.runtimeUrl;

  console.log("Vellum Setup");
  console.log("============\n");

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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (entry.bearerToken) {
    headers["Authorization"] = `Bearer ${entry.bearerToken}`;
  }

  const response = await fetch(`${gatewayUrl}/v1/secrets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "credential",
      name: "ANTHROPIC_API_KEY",
      value: apiKey.trim(),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.error(
      `Error: Failed to store API key in assistant (${response.status}).`,
    );
    process.exit(1);
  }

  console.log("\nAPI key saved to assistant. Setup complete.");
}
