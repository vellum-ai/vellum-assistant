import {
  workspaceFileGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { assertHasResponse } from "@/utils/api-errors";
import {
  type PreChatOnboardingContext,
  type PreChatOnboardingProfileFields,
  preChatOnboardingProfileFields,
} from "@/domains/onboarding/prechat";

export const PRECHAT_PROFILE_PATHS = [
  "users/guardian.md",
  "users/default.md",
] as const;

export const ONBOARDING_HEADING = "## Onboarding Context";

export function buildOnboardingSection(
  fields: PreChatOnboardingProfileFields,
): string {
  const lines: string[] = [ONBOARDING_HEADING, ""];

  if (fields.preferredName) {
    lines.push(`- **Preferred name:** ${fields.preferredName}`);
  }
  if (fields.occupation) {
    lines.push(`- **Role:** ${fields.occupation}`);
  }
  if (fields.commonWork.length > 0) {
    lines.push(`- **Common work:** ${fields.commonWork.join("; ")}`);
  }
  if (fields.dailyTools.length > 0) {
    lines.push(`- **Daily tools:** ${fields.dailyTools.join(", ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function upsertOnboardingSection(
  existingContent: string | null,
  section: string,
): string {
  let content = existingContent ?? "# User Profile\n\n";
  const headingIndex = content.indexOf(ONBOARDING_HEADING);

  if (headingIndex !== -1) {
    const afterHeading = content.indexOf("\n", headingIndex);
    const rest = afterHeading !== -1 ? content.slice(afterHeading + 1) : "";
    const nextHeadingMatch = rest.match(/^## /m);
    const before = content.slice(0, headingIndex);
    const after = nextHeadingMatch ? rest.slice(nextHeadingMatch.index!) : "";
    return before + section + after;
  }

  if (!content.endsWith("\n")) {
    content += "\n";
  }
  if (!content.endsWith("\n\n")) {
    content += "\n";
  }
  return content + section;
}

async function fetchWorkspaceTextFile(
  assistantId: string,
  path: string,
): Promise<string | null> {
  const { data, error, response } = await workspaceFileGet({
    path: { assistant_id: assistantId },
    query: { path },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to fetch onboarding profile file");

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch onboarding profile file (${response.status})`,
    );
  }
  if (data?.isBinary) {
    throw new Error("Onboarding profile file is binary");
  }
  return typeof data?.content === "string" ? data.content : null;
}

async function writeWorkspaceTextFile(
  assistantId: string,
  path: string,
  content: string,
): Promise<void> {
  const { error, response } = await workspaceWritePost({
    path: { assistant_id: assistantId },
    body: { path, content },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to write onboarding profile file");
  if (!response.ok) {
    throw new Error(
      `Failed to write onboarding profile file (${response.status})`,
    );
  }
}

async function persistOnboardingProfilePath(
  assistantId: string,
  path: string,
  section: string,
): Promise<void> {
  const existing = await fetchWorkspaceTextFile(assistantId, path);
  const nextContent = upsertOnboardingSection(existing, section);
  await writeWorkspaceTextFile(assistantId, path, nextContent);
}

/**
 * Best-effort first-turn profile seeding for the web client.
 *
 * The daemon still receives the normal `onboarding` payload with the first
 * message. This extra write makes the context available to prompt assembly
 * before that message is processed and covers the web trust-context fallback
 * that currently reads `users/default.md`.
 */
export async function persistPreChatOnboardingProfile(
  assistantId: string,
  onboarding: PreChatOnboardingContext,
): Promise<void> {
  const fields = preChatOnboardingProfileFields(onboarding);
  const section = buildOnboardingSection(fields);

  await Promise.allSettled(
    PRECHAT_PROFILE_PATHS.map((path) =>
      persistOnboardingProfilePath(assistantId, path, section),
    ),
  );
}
