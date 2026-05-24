import { readPlatformToken, getWebUrl } from "../lib/platform-client.js";

function printUsage(): void {
  console.log("Usage: vellum roadmap <subcommand>");
  console.log("");
  console.log("Manage roadmap items.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  create --title <title> [--description <desc>] [--tag <slug>...]",
  );
  console.log("");
  console.log("Examples:");
  console.log('  $ vellum roadmap create --title "Add dark mode"');
  console.log(
    '  $ vellum roadmap create --title "OAuth support" --description "Support for Google and GitHub" --tag integrations',
  );
}

function consumeValue(args: string[], i: number, flag: string): string {
  const next = args[i + 1];
  if (next === undefined || next.startsWith("--")) {
    console.error(`Error: ${flag} requires a value.`);
    process.exit(1);
  }
  return next;
}

function parseCreateArgs(args: string[]): {
  title: string | undefined;
  description: string | undefined;
  tags: string[];
} {
  let title: string | undefined;
  let description: string | undefined;
  const tags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--title":
        title = consumeValue(args, i, "--title");
        i++;
        break;
      case "--description":
        description = consumeValue(args, i, "--description");
        i++;
        break;
      case "--tag":
        tags.push(consumeValue(args, i, "--tag"));
        i++;
        break;
    }
  }

  return { title, description, tags };
}

async function roadmapCreate(args: string[]): Promise<void> {
  const { title, description, tags } = parseCreateArgs(args);

  if (!title) {
    console.error("Error: --title is required.");
    console.error('Usage: vellum roadmap create --title "My feature request"');
    process.exitCode = 1;
    return;
  }

  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run `vellum login` first.");
    process.exitCode = 1;
    return;
  }

  const webUrl = getWebUrl();
  const url = `${webUrl}/api/marketing/v1/roadmap`;

  const body: Record<string, unknown> = { title };
  if (description) body.description = description;
  if (tags.length > 0) body.tags = tags;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": token,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`Failed to create roadmap item (${response.status}): ${text}`);
    process.exitCode = 1;
    return;
  }

  const item = (await response.json()) as {
    slug: string;
    title: string;
    status: string;
  };

  console.log(`Created roadmap item: ${item.title}`);
  console.log(`  slug:   ${item.slug}`);
  console.log(`  status: ${item.status}`);
  console.log(`  url:    ${webUrl}/roadmap/${item.slug}`);
}

export async function roadmap(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printUsage();
    return;
  }

  switch (sub) {
    case "create":
      await roadmapCreate(args.slice(1));
      break;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
