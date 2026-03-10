import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getWorkspacePromptPath, readLockfile } from "../../util/platform.js";
import { type HandlerContext, log } from "./shared.js";

export interface IdentityFields {
  name: string;
  role: string;
  personality: string;
  emoji: string;
  home: string;
}

/** Parse the core identity fields from IDENTITY.md content. */
export function parseIdentityFields(content: string): IdentityFields {
  const fields: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const extract = (prefix: string): string | null => {
      if (!lower.startsWith(prefix)) return null;
      return trimmed.split(":**").pop()?.trim() ?? null;
    };

    const name = extract("- **name:**");
    if (name) {
      fields.name = name;
      continue;
    }
    const role = extract("- **role:**");
    if (role) {
      fields.role = role;
      continue;
    }
    const personality = extract("- **personality:**") ?? extract("- **vibe:**");
    if (personality) {
      fields.personality = personality;
      continue;
    }
    const emoji = extract("- **emoji:**");
    if (emoji) {
      fields.emoji = emoji;
      continue;
    }
    const home = extract("- **home:**");
    if (home) {
      fields.home = home;
      continue;
    }
  }
  return {
    name: fields.name ?? "",
    role: fields.role ?? "",
    personality: fields.personality ?? "",
    emoji: fields.emoji ?? "",
    home: fields.home ?? "",
  };
}

function handleIdentityGet(ctx: HandlerContext): void {
  const identityPath = getWorkspacePromptPath("IDENTITY.md");

  if (!existsSync(identityPath)) {
    ctx.send({
      type: "identity_get_response",
      found: false,
      name: "",
      role: "",
      personality: "",
      emoji: "",
      home: "",
    });
    return;
  }

  try {
    const content = readFileSync(identityPath, "utf-8");
    const fields = parseIdentityFields(content);

    // Read version from package.json
    let version: string | undefined;
    try {
      const pkgPath = join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      version = pkg.version;
    } catch {
      // ignore
    }

    // Read createdAt from IDENTITY.md file birthtime
    let createdAt: string | undefined;
    try {
      const stats = statSync(identityPath);
      createdAt = stats.birthtime.toISOString();
    } catch {
      // ignore
    }

    // Read lockfile for assistantId, cloud, and originSystem
    let assistantId: string | undefined;
    let cloud: string | undefined;
    let originSystem: string | undefined;
    try {
      const lockData = readLockfile();
      const assistants = lockData?.assistants as
        | Array<Record<string, unknown>>
        | undefined;
      if (assistants && assistants.length > 0) {
        // Use the most recently hatched assistant
        const sorted = [...assistants].sort((a, b) => {
          const dateA = new Date((a.hatchedAt as string) || 0).getTime();
          const dateB = new Date((b.hatchedAt as string) || 0).getTime();
          return dateB - dateA;
        });
        const latest = sorted[0];
        assistantId = latest.assistantId as string | undefined;
        cloud = latest.cloud as string | undefined;
        originSystem = cloud === "local" ? "local" : cloud;
      }
    } catch {
      // ignore — lockfile may not exist
    }

    ctx.send({
      type: "identity_get_response",
      found: true,
      name: fields.name,
      role: fields.role,
      personality: fields.personality,
      emoji: fields.emoji,
      home: fields.home,
      version,
      assistantId,
      createdAt,
      originSystem,
    });
  } catch (err) {
    log.error({ err }, "Failed to read identity");
    ctx.send({
      type: "identity_get_response",
      found: false,
      name: "",
      role: "",
      personality: "",
      emoji: "",
      home: "",
    });
  }
}