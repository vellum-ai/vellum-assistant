export type DecisionOutput =
  | { shouldBuild: false; skipReason: string }
  | {
      shouldBuild: true;
      artifactType: "app" | "document";
      artifactTitle: string;
      artifactDescription: string;
    };

export function buildDecisionPrompt(transcript: string): string {
  return `You are deciding whether to proactively build a personalized artifact for the user based on their conversation so far.

Read the conversation below carefully. Your job:
1. Identify what the user cares about — their goals, context, specific details they've shared.
2. Decide: should we build a small interactive app or document that would delight this specific user?
3. Quality test: Could you have built the same thing for any random person? If yes, too generic — output SHOULD_BUILD: no.

Rules:
- Only say yes if you can build something SPECIFIC to this user's situation, using details from their conversation.
- An "app" is a small interactive web application (calculator, tracker, visualizer, planner, etc.)
- A "document" is a structured reference (checklist, guide, comparison table, template, etc.)
- The title and description must reference specifics from the conversation — names, numbers, goals, constraints the user mentioned.
- Do NOT include a MESSAGE field.

Conversation:
${transcript}

Respond in EXACTLY this format (no extra text before or after):

SHOULD_BUILD: [yes|no]
SKIP_REASON: [required if no — why this conversation isn't a good fit]
ARTIFACT_TYPE: [app|document]
ARTIFACT_TITLE: [specific title seeded with user context]
ARTIFACT_DESCRIPTION: [1-3 sentence build spec with user-specific details]

If SHOULD_BUILD is no, omit ARTIFACT_TYPE, ARTIFACT_TITLE, and ARTIFACT_DESCRIPTION.
If SHOULD_BUILD is yes, omit SKIP_REASON.`;
}

export function parseDecisionOutput(text: string): DecisionOutput | null {
  const lines = text.trim().split("\n");

  const shouldBuildLine = lines.find((line) =>
    line.trim().startsWith("SHOULD_BUILD:"),
  );
  if (!shouldBuildLine) return null;

  const shouldBuildValue = shouldBuildLine
    .split(":")
    .slice(1)
    .join(":")
    .trim()
    .toLowerCase();

  if (shouldBuildValue === "no") {
    const skipReasonLine = lines.find((line) =>
      line.trim().startsWith("SKIP_REASON:"),
    );
    const skipReason = skipReasonLine
      ? skipReasonLine.split(":").slice(1).join(":").trim()
      : "no reason given";
    return { shouldBuild: false, skipReason };
  }

  if (shouldBuildValue === "yes") {
    const artifactTypeLine = lines.find((line) =>
      line.trim().startsWith("ARTIFACT_TYPE:"),
    );
    if (!artifactTypeLine) return null;
    const artifactType = artifactTypeLine
      .split(":")
      .slice(1)
      .join(":")
      .trim()
      .toLowerCase();
    if (artifactType !== "app" && artifactType !== "document") return null;

    const artifactTitleLine = lines.find((line) =>
      line.trim().startsWith("ARTIFACT_TITLE:"),
    );
    if (!artifactTitleLine) return null;
    const artifactTitle = artifactTitleLine
      .split(":")
      .slice(1)
      .join(":")
      .trim();
    if (!artifactTitle) return null;

    const artifactDescriptionStartIndex = lines.findIndex((line) =>
      line.trim().startsWith("ARTIFACT_DESCRIPTION:"),
    );
    if (artifactDescriptionStartIndex === -1) return null;

    const firstDescLine = lines[artifactDescriptionStartIndex]
      .split(":")
      .slice(1)
      .join(":")
      .trim();

    // Collect continuation lines (lines after ARTIFACT_DESCRIPTION that aren't other fields)
    const descriptionParts = [firstDescLine];
    for (let i = artifactDescriptionStartIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (
        line.startsWith("SHOULD_BUILD:") ||
        line.startsWith("SKIP_REASON:") ||
        line.startsWith("ARTIFACT_TYPE:") ||
        line.startsWith("ARTIFACT_TITLE:")
      ) {
        break;
      }
      descriptionParts.push(line);
    }

    const artifactDescription = descriptionParts.join("\n").trim();
    if (!artifactDescription) return null;

    return {
      shouldBuild: true,
      artifactType: artifactType as "app" | "document",
      artifactTitle,
      artifactDescription,
    };
  }

  return null;
}

export function formatTranscript(
  messages: Array<{ role: string; content: string }>,
): string {
  return messages
    .map((msg) => {
      const label =
        msg.role === "user"
          ? "[User]"
          : msg.role === "assistant"
            ? "[Assistant]"
            : `[${msg.role}]`;
      const content = parseContent(msg.content);
      return `${label}: ${content}`;
    })
    .join("\n\n");
}

function parseContent(content: string): string {
  // Try to parse as JSON content block array
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((block) => {
          if (typeof block === "string") return block;
          if (block.type === "text" && typeof block.text === "string")
            return block.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    // Not JSON, treat as plain text
  }
  return content;
}
