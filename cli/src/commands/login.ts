import {
  clearPlatformToken,
  fetchCurrentUser,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client";

export async function login(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: assistant login --token <session-token>");
    console.log("");
    console.log("Log in to the Vellum platform.");
    console.log("");
    console.log("Options:");
    console.log("  --token <token>    Session token from the Vellum platform");
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

  if (!token) {
    console.error("Usage: assistant login --token <session-token>");
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
    console.error(
      `❌ Login failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
}

export async function logout(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: assistant logout");
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
    console.log("Usage: assistant whoami");
    console.log("");
    console.log("Show the currently logged-in Vellum platform user.");
    process.exit(0);
  }

  const token = readPlatformToken();
  if (!token) {
    console.error(
      "Not logged in. Run `assistant login --token <token>` first.",
    );
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
