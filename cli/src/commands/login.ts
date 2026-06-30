import { randomBytes } from "crypto";
import { createServer } from "http";
import type { AddressInfo } from "net";

import {
  getActiveAssistant,
  loadAllAssistants,
  removeAssistantEntry,
  resolveAssistant,
  saveAssistantPlatformRegistration,
  setActiveAssistant,
} from "../lib/assistant-config";
import { computeDeviceId } from "../lib/guardian-token";
import { openBrowser } from "../lib/open-browser";
import {
  clearPlatformToken,
  ensureSelfHostedLocalRegistration,
  fetchCurrentUser,
  fetchOrganizationId,
  fetchPlatformAssistants,
  getPlatformUrl,
  injectCredentialsIntoAssistant,
  readGatewayCredential,
  readPlatformToken,
  reprovisionAssistantApiKey,
  savePlatformToken,
} from "../lib/platform-client";
import { syncCloudAssistants } from "../lib/sync-cloud-assistants";
import {
  fetchAssistantIngressUrl,
  fetchCurrentVersion,
} from "../lib/upgrade-lifecycle.js";
import {
  CALLBACK_PATH,
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
} from "../lib/workos-pkce";

const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLoginPage(
  title: string,
  subtitle: string,
  success: boolean,
): string {
  const checkmarkSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="28" cy="28" r="28" fill="var(--positive-bg)"/>
      <path class="check" d="M17 28.5L24.5 36L39 21" stroke="var(--positive-fg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`;

  const errorSvg = `<svg class="icon" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="28" cy="28" r="28" fill="var(--negative-bg)"/>
      <path class="cross cross-1" d="M20 20L36 36" stroke="var(--negative-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      <path class="cross cross-2" d="M36 20L20 36" stroke="var(--negative-fg)" stroke-width="3.5" stroke-linecap="round" fill="none"/>
    </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --surface: #F5F3EB;
      --surface-card: #FFFFFF;
      --card-border: #E8E6DA;
      --text-primary: #2A2A28;
      --text-secondary: #4A4A46;
      --positive-bg: #D4DFD0;
      --positive-fg: #516748;
      --negative-bg: #F7DAC9;
      --negative-fg: #DA491A;
      --shadow: 0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06);
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: #1A1A18;
        --surface-card: #2A2A28;
        --card-border: #3A3A37;
        --text-primary: #F5F3EB;
        --text-secondary: #BDB9A9;
        --positive-bg: #1A2316;
        --positive-fg: #7A8B6F;
        --negative-bg: #4E281D;
        --negative-fg: #E86B40;
        --shadow: 0 1px 3px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.3);
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font);
      background: var(--surface);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      text-align: center;
      padding: 48px 40px 40px;
      background: var(--surface-card);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      max-width: 380px;
      width: 100%;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      animation: cardIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s forwards;
    }
    @keyframes cardIn {
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .icon {
      width: 56px;
      height: 56px;
      margin-bottom: 20px;
    }
    .check {
      stroke-dasharray: 32;
      stroke-dashoffset: 32;
      animation: draw 0.4s ease-out 0.45s forwards;
    }
    .cross {
      stroke-dasharray: 22;
      stroke-dashoffset: 22;
    }
    .cross-1 { animation: draw 0.3s ease-out 0.45s forwards; }
    .cross-2 { animation: draw 0.3s ease-out 0.55s forwards; }
    @keyframes draw {
      to { stroke-dashoffset: 0; }
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.2px;
      color: var(--text-primary);
      margin-bottom: 6px;
    }
    p {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary);
    }
  </style>
</head>
<body>
  <div class="card">
    ${success ? checkmarkSvg : errorSvg}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle)}</p>
  </div>
</body>
</html>`;
}

export interface LoopbackListener {
  /** The full `http://127.0.0.1:<port>/auth/callback` redirect URI. */
  redirectUri: string;
  /** Resolves with the authorization code once the state-matched callback arrives. */
  waitForCode: Promise<string>;
  /** Tear down the server, rejecting any pending waiter with `reason`. */
  close: (reason?: string) => void;
}

/**
 * Bind an ephemeral 127.0.0.1 listener and wait for the OAuth redirect.
 * Exported for tests; production callers go through `workosPkceLogin`.
 */
export function startLoopbackListener(
  expectedState: string,
): Promise<LoopbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: {
      resolve: (code: string) => void;
      reject: (err: Error) => void;
    };
    const waitForCode = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        url.pathname !== CALLBACK_PATH ||
        url.searchParams.get("state") !== expectedState
      ) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          renderLoginPage(
            "Login Failed",
            "Please try again from your terminal.",
            false,
          ),
        );
        server.close();
        settle.reject(
          new Error(
            `Authentication failed: ${error ?? "no authorization code received"}`,
          ),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderLoginPage(
          "Login Successful",
          "You can close this window and return to your terminal.",
          true,
        ),
      );
      server.close();
      settle.resolve(code);
    });

    server.on("error", rejectListener);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        rejectListener(new Error("Failed to start local server."));
        return;
      }
      const { port } = addr as AddressInfo;
      resolveListener({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        waitForCode,
        close: (reason?: string) => {
          server.close();
          settle.reject(new Error(reason ?? "Login cancelled."));
        },
      });
    });
  });
}

/** App-held WorkOS PKCE login */
async function workosPkceLogin(platformUrl: string): Promise<string> {
  const clientId = await fetchWorkosClientId(platformUrl);
  const { verifier, challenge } = generatePkcePair();
  const state = randomBytes(32).toString("hex");

  const listener = await startLoopbackListener(state);
  const timeout = setTimeout(() => {
    listener.close("Login timed out. Please try again.");
  }, LOGIN_TIMEOUT_MS);

  try {
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      redirectUri: listener.redirectUri,
      challenge,
      state,
    });

    console.log("Opening browser for login...");
    console.log(`If the browser doesn't open, visit: ${authorizeUrl}`);
    openBrowser(authorizeUrl);

    const code = await listener.waitForCode;
    const accessToken = await exchangeCodeWithWorkos({
      clientId,
      code,
      verifier,
    });
    return await exchangeAccessTokenForSession(
      platformUrl,
      clientId,
      accessToken,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function login(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum login [--token <session-token>] [--force]");
    console.log("");
    console.log("Log in to the Vellum platform.");
    console.log("");
    console.log("By default, opens a browser window for authentication.");
    console.log("Alternatively, pass a session token directly with --token.");
    console.log("");
    console.log("On success, syncs cloud-managed assistants to the local");
    console.log("lockfile so they appear in `vellum ps`.");
    console.log("");
    console.log("Options:");
    console.log("  --token <token>    Session token from the Vellum platform");
    console.log(
      "  --force, -f        Re-authenticate even if already logged in",
    );
    console.log("");
    console.log("Examples:");
    console.log("  vellum login");
    console.log("  vellum login --token <session-token>");
    console.log("  vellum login --force");
    process.exit(0);
  }

  const forceFlag = args.includes("--force") || args.includes("-f");
  let token: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token") {
      token = args[i + 1];
      if (!token) {
        console.error("Error: --token requires a value");
        process.exit(1);
      }
      break;
    }
  }

  // Block if already authenticated (unless --force)
  if (!forceFlag && !token) {
    const existingToken = readPlatformToken();
    if (existingToken) {
      try {
        const existingUser = await fetchCurrentUser(existingToken);
        console.error(
          `Already logged in as ${existingUser.email}. Run \`vellum logout\` first, or use \`vellum login --force\` to re-authenticate.`,
        );
        process.exit(1);
      } catch {
        // Token is stale/invalid — proceed with login
      }
    }
  }

  // If no --token flag, use app-held WorkOS PKCE login.
  if (!token) {
    try {
      token = await workosPkceLogin(getPlatformUrl());
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  console.log("Validating token...");

  try {
    const user = await fetchCurrentUser(token);
    savePlatformToken(token);
    console.log(`✅ Logged in as ${user.email}`);

    // Register the local assistant with the platform (non-fatal).
    // Mirrors the desktop app's LocalAssistantBootstrapService flow.
    try {
      const entry = resolveAssistant();

      // Skip managed ("vellum") assistants — they are handled by the platform.
      if (entry && entry.cloud !== "vellum") {
        const orgId = await fetchOrganizationId(token);
        const clientInstallationId = computeDeviceId();
        const [assistantVersion, ingressUrl] = await Promise.all([
          fetchCurrentVersion(entry.runtimeUrl),
          fetchAssistantIngressUrl(entry.runtimeUrl, entry.bearerToken),
        ]);
        const registration = await ensureSelfHostedLocalRegistration(
          token,
          orgId,
          clientInstallationId,
          entry.assistantId,
          "cli",
          assistantVersion,
          getPlatformUrl(),
          ingressUrl,
        );
        console.log(
          `Registered assistant: ${registration.assistant.name} (${registration.assistant.id})`,
        );
        saveAssistantPlatformRegistration(entry.assistantId, {
          platformAssistantId: registration.assistant.id,
          platformBaseUrl: getPlatformUrl(),
          platformOrganizationId: orgId,
        });

        // Resolve the API key to inject, mirroring the macOS app's
        // LocalAssistantBootstrapService 3-step flow:
        // 1. Use fresh key from registration (first-time only)
        // 2. Use existing key from the daemon's credential store
        // 3. Reprovision (rotate) as a last resort — this revokes the
        //    old key server-side, so we only do it when the gateway
        //    confirms no key exists (not when it's merely unreachable).
        let assistantApiKey = registration.assistant_api_key;
        if (!assistantApiKey) {
          const cached = await readGatewayCredential(
            entry.runtimeUrl,
            "vellum:assistant_api_key",
            entry.bearerToken,
          );
          if (cached.value) {
            assistantApiKey = cached.value;
          } else if (!cached.unreachable) {
            console.log("No API key available locally — reprovisioning...");
            const reprovision = await reprovisionAssistantApiKey(
              token,
              orgId,
              clientInstallationId,
              entry.assistantId,
              "cli",
            );
            assistantApiKey = reprovision.provisioning.assistant_api_key;
          }
        }

        // Inject credentials into the running assistant via the gateway,
        // mirroring the desktop app's LocalAssistantBootstrapService flow.
        const allInjected = await injectCredentialsIntoAssistant({
          gatewayUrl: entry.runtimeUrl,
          bearerToken: entry.bearerToken,
          assistantApiKey,
          platformAssistantId: registration.assistant.id,
          platformBaseUrl: getPlatformUrl(),
          organizationId: orgId,
          userId: user.id,
          webhookSecret: registration.webhook_secret,
        });
        if (allInjected) {
          console.log("Injected platform credentials into assistant.");
        } else {
          console.warn(
            "Some credentials could not be injected into the assistant.",
          );
        }
      }
    } catch {
      // Non-fatal — login succeeded even if registration fails
    }

    // Sync cloud assistants from the platform into the local lockfile.
    // This ensures `vellum ps` shows managed assistants immediately
    // after login (e.g. after a retire-and-rehatch cycle). We've just
    // saved this token, so it's guaranteed non-empty here.
    try {
      const result = await syncCloudAssistants(token);
      if (result) {
        const total = result.added + result.removed;
        if (total > 0) {
          console.log(
            `Synced cloud assistants (${result.added} added, ${result.removed} removed).`,
          );
        }
      }

      // If no active assistant is set, activate the first cloud one.
      if (!getActiveAssistant()) {
        const platformAssistants = await fetchPlatformAssistants(token);
        if (platformAssistants.length > 0) {
          setActiveAssistant(platformAssistants[0].id);
        }
      }
    } catch {
      // Non-fatal — login succeeded even if sync fails
    }
  } catch (error) {
    console.error(
      `❌ Login failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

export async function logout(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum logout");
    console.log("");
    console.log(
      "Log out of the Vellum platform, remove the stored session token,",
    );
    console.log("and remove cloud-managed assistants from the local lockfile.");
    process.exit(0);
  }

  // Remove cloud-managed assistants from the lockfile.
  const cloudAssistants = loadAllAssistants().filter(
    (a) => a.cloud === "vellum",
  );
  for (const a of cloudAssistants) {
    removeAssistantEntry(a.assistantId);
  }
  if (cloudAssistants.length > 0) {
    console.log(
      `Removed ${cloudAssistants.length} cloud assistant${cloudAssistants.length > 1 ? "s" : ""} from local lockfile.`,
    );
  }

  clearPlatformToken();
  console.log("Logged out. Platform token removed.");
}

export async function whoami(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum whoami");
    console.log("");
    console.log("Show the currently logged-in Vellum platform user.");
    process.exit(0);
  }

  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `vellum login` first.");
    process.exit(1);
  }

  try {
    const user = await fetchCurrentUser(token);
    console.log(`Email: ${user.email}`);
    if (user.display) {
      console.log(`Name:  ${user.display}`);
    }
    console.log(`ID:    ${user.id}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
