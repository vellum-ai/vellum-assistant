import {
  clearPlatformToken,
  fetchCurrentUser,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client";

export async function login(): Promise<void> {
  const args = process.argv.slice(3);
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

  if (!token) {
    console.error("Usage: vellum login --token <session-token>");
    console.error("");
    console.error("To get your session token:");
    console.error("  1. Log in to the Vellum platform in your browser");
    console.error("  2. Open Developer Tools → Application → Cookies");
    console.error("  3. Copy the value of the session token");
    process.exit(1);
  }

  console.log("Validating token...");

  try {
    const user = await fetchCurrentUser(token);
    savePlatformToken(token);
    console.log(`✅ Logged in as ${user.email}`);
  } catch (error) {
    console.error(`❌ Login failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

export async function logout(): Promise<void> {
  clearPlatformToken();
  console.log("Logged out. Platform token removed.");
}

export async function whoami(): Promise<void> {
  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `vellum login --token <token>` first.");
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
