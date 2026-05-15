import { resolveAssistant } from "../lib/assistant-config.js";
import {
  leaseGuardianToken,
  loadGuardianToken,
  refreshGuardianToken,
  type GuardianTokenData,
} from "../lib/guardian-token.js";
import {
  ensureProviderApiKey,
  formatProviderName,
} from "../lib/provider-secrets.js";

function parseSetupArgs(args: string[]): { provider: string } {
  let provider = "anthropic";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--provider requires a provider name.");
      }
      provider = value;
      i++;
    } else if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { provider };
}

function isGuardianAccessTokenUsable(
  tokenData: GuardianTokenData | null,
): tokenData is GuardianTokenData {
  if (!tokenData?.accessToken) {
    return false;
  }
  const expiresAt = new Date(tokenData.accessTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function resolveSetupBearerToken(
  entry: NonNullable<ReturnType<typeof resolveAssistant>>,
  gatewayUrl: string,
): Promise<string | undefined> {
  const guardianToken = loadGuardianToken(entry.assistantId);
  if (isGuardianAccessTokenUsable(guardianToken)) {
    return guardianToken.accessToken;
  }

  if (guardianToken) {
    const refreshedToken = await refreshGuardianToken(
      gatewayUrl,
      entry.assistantId,
    );
    if (isGuardianAccessTokenUsable(refreshedToken)) {
      return refreshedToken.accessToken;
    }
  }

  const canLeaseGuardianToken =
    entry.cloud === "local" || entry.cloud === "docker" || entry.localUrl;
  if (canLeaseGuardianToken) {
    try {
      const bootstrapSecret =
        typeof entry.guardianBootstrapSecret === "string"
          ? entry.guardianBootstrapSecret
          : undefined;
      const leasedToken = await leaseGuardianToken(
        gatewayUrl,
        entry.assistantId,
        bootstrapSecret,
      );
      if (isGuardianAccessTokenUsable(leasedToken)) {
        return leasedToken.accessToken;
      }
    } catch {
      // Fall through to any lockfile bearer token, or let the setup request
      // surface the gateway's auth error below.
    }
  }

  return entry.bearerToken;
}

export async function setup(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum setup [--provider <provider>]");
    console.log("");
    console.log("Configure a provider API key on the active assistant.");
    console.log("");
    console.log("Options:");
    console.log(
      "  --provider <provider>  Provider to configure. Defaults to anthropic.",
    );
    console.log("");
    console.log("Behavior:");
    console.log(
      "  - Checks the active assistant for an existing provider key.",
    );
    console.log("  - Uses the matching environment variable when it is set.");
    console.log("  - Otherwise prompts securely without echoing the key.");
    console.log("");
    console.log("Examples:");
    console.log("  vellum setup");
    console.log("  ANTHROPIC_API_KEY=... vellum setup");
    console.log("  vellum setup --provider openai");
    process.exit(0);
  }

  let parsed: { provider: string };
  try {
    parsed = parseSetupArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    process.exit(1);
  }

  const entry = resolveAssistant();
  if (!entry) {
    console.error(
      "Error: No active assistant found. Run `vellum hatch` first.",
    );
    process.exit(1);
  }

  const gatewayUrl = entry.localUrl ?? entry.runtimeUrl;
  const bearerToken = await resolveSetupBearerToken(entry, gatewayUrl);

  console.log("Vellum Setup");
  console.log("============\n");

  try {
    const result = await ensureProviderApiKey({
      gatewayUrl,
      provider: parsed.provider,
      bearerToken,
      env: process.env,
    });

    if (result.status === "already_configured") {
      console.log(
        `${formatProviderName(result.provider)} API key is already configured.`,
      );
      return;
    }

    if (result.status === "configured") {
      const providerName = formatProviderName(result.provider);
      const source = result.source === "env" ? " from the environment" : "";
      console.log(`\n${providerName} API key saved to assistant${source}.`);
      console.log("Setup complete.");
      return;
    }

    if (result.status === "skipped") {
      console.log(result.message);
      return;
    }

    console.error(`Error: ${result.message}`);
    process.exit(1);
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Error: ${error.message}`
        : "Error: Setup failed.",
    );
    process.exit(1);
  }
}
