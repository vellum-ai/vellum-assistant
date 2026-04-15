import { createServer } from "http";
import { spawn } from "child_process";
import { randomBytes } from "crypto";

import {
  findAssistantByName,
  getActiveAssistant,
  loadLatestAssistant,
} from "../lib/assistant-config";
import { computeDeviceId } from "../lib/guardian-token";
import {
  clearPlatformToken,
  ensureSelfHostedLocalRegistration,
  fetchCurrentUser,
  fetchOrganizationId,
  getPlatformUrl,
  injectCredentialsIntoAssistant,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client";

const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Open a URL in the user's default browser.
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args =
    platform === "win32"
      ? ["/c", "start", '""', url.replace(/&/g, "^&")]
      : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Silently ignore — the user can still copy the URL from the console
  });
  child.unref();
}

/**
 * Start a local HTTP server, open the browser to the platform login page,
 * and wait for the platform to redirect back with the session token.
 */
function browserLogin(platformUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const state = randomBytes(32).toString("hex");

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const receivedState = url.searchParams.get("state");
      const sessionToken = url.searchParams.get("session_token");

      if (receivedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Login failed</h2><p>State mismatch. Please try again.</p></body></html>",
        );
        cleanup("State mismatch — possible CSRF attack.");
        return;
      }

      if (!sessionToken) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Login failed</h2><p>No session token received. Please try again.</p></body></html>",
        );
        cleanup("No session token received from platform.");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Login successful!</h2><p>You can close this window and return to your terminal.</p></body></html>",
      );
      cleanup(null, sessionToken);
    });

    const timeout = setTimeout(() => {
      cleanup("Login timed out. Please try again.");
    }, LOGIN_TIMEOUT_MS);

    function cleanup(error: string | null, token?: string): void {
      clearTimeout(timeout);
      server.close();
      if (error) {
        reject(new Error(error));
      } else if (token) {
        resolve(token);
      } else {
        reject(new Error("Unknown error during login."));
      }
    }

    server.on("error", (err) => cleanup(err.message));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        cleanup("Failed to start local server.");
        return;
      }

      const port = addr.port;
      const returnTo = `/accounts/cli/callback?port=${port}&state=${state}`;
      const loginUrl = `${platformUrl}/account/login?returnTo=${encodeURIComponent(returnTo)}`;

      console.log("Opening browser for login...");
      console.log(`If the browser doesn't open, visit: ${loginUrl}`);
      openBrowser(loginUrl);
    });
  });
}

export async function login(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum login [--token <session-token>]");
    console.log("");
    console.log("Log in to the Vellum platform.");
    console.log("");
    console.log("By default, opens a browser window for authentication.");
    console.log("Alternatively, pass a session token directly with --token.");
    console.log("");
    console.log("Options:");
    console.log("  --token <token>    Session token from the Vellum platform");
    console.log("");
    console.log("Examples:");
    console.log("  vellum login");
    console.log("  vellum login --token <session-token>");
    process.exit(0);
  }

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

  // If no --token flag, use browser-based login
  if (!token) {
    const platformUrl = getPlatformUrl();
    try {
      token = await browserLogin(platformUrl);
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
      const activeName = getActiveAssistant();
      const entry = activeName
        ? findAssistantByName(activeName)
        : loadLatestAssistant();

      // Skip managed ("vellum") assistants — they are handled by the platform.
      if (entry && entry.cloud !== "vellum") {
        const orgId = await fetchOrganizationId(token);
        const clientInstallationId = computeDeviceId();
        const registration = await ensureSelfHostedLocalRegistration(
          token,
          orgId,
          clientInstallationId,
          entry.assistantId,
          "cli",
        );
        console.log(
          `Registered assistant: ${registration.assistant.name} (${registration.assistant.id})`,
        );

        // Inject credentials into the running assistant via the gateway,
        // mirroring the desktop app's LocalAssistantBootstrapService flow.
        const allInjected = await injectCredentialsIntoAssistant({
          gatewayUrl: entry.runtimeUrl,
          bearerToken: entry.bearerToken,
          assistantApiKey: registration.assistant_api_key,
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
      "Log out of the Vellum platform and remove the stored session token.",
    );
    process.exit(0);
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
