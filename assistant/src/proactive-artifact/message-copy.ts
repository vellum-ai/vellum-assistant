/**
 * Post-build message copy generation for proactive artifacts.
 *
 * After building an artifact, we ask the LLM to write a short,
 * conversational message explaining what was built and why.
 */

export function buildMessageCopyPrompt(params: {
  artifactType: "app" | "document";
  artifactTitle: string;
  artifactId: string;
  transcript: string;
}): string {
  return `You just built a personalized ${params.artifactType} for the user based on their conversation.

Artifact details:
- Type: ${params.artifactType}
- Title: ${params.artifactTitle}
- ID: ${params.artifactId}

Original conversation:
${params.transcript}

Write a short message (2-3 sentences) to the user explaining:
1. What you built
2. Why you built it (reference something specific from the conversation)
3. Where to find it: say the ${params.artifactType} is available in Library.

Keep it warm and natural — not robotic. This should feel like a thoughtful gift, not a system notification.
Do not call it an artifact, artifact panel, or artifact drawer.

Respond in EXACTLY this format (no extra text before or after):

MESSAGE: <your message>`;
}

export function parseMessageCopy(text: string): string | null {
  const match = text.match(/^MESSAGE:\s*(.+)/ms);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

export function ensureMessageMentionsLibraryLocation(
  message: string,
  artifactType: "app" | "document",
): string {
  const trimmed = message
    .replace(/\bartifact\s+(?:panel|drawer)\b/gi, "Library")
    .replace(/\bartifacts\s+(?:panel|drawer)\b/gi, "Library")
    .trim();
  const mentionsLibrary = /\blibrary\b/i.test(trimmed);
  if (mentionsLibrary) return trimmed;

  const noun = artifactType === "app" ? "app" : "document";
  const suffix = `You can find the ${noun} in Library.`;
  return `${trimmed.replace(/[ \t]+$/, "").replace(/[.!?]*$/, ".")} ${suffix}`;
}
