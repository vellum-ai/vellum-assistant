/**
 * Deterministically persist the cast assistant's chosen name to the daemon's
 * `IDENTITY.md`.
 *
 * The displayed assistant name is driven by the daemon identity
 * (`identityGet` → the `- **Name:**` line in `IDENTITY.md`), which the daemon
 * otherwise only fills from `onboarding.assistantName` on the first message.
 * The cast flow sends that first message (the research directive) right after
 * the name/occupation step — *before* the user names their assistant in the
 * starter screen — so the name can't ride it. Instead, once the name is known
 * we write it straight into `IDENTITY.md` via the same workspace-file API the
 * onboarding profile seeding uses (a targeted read-modify-write of just the
 * Name line, leaving the daemon's other identity fields intact).
 */
import {
  workspaceFileGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";

/** IDENTITY.md lives at the workspace root (see daemon `getWorkspacePromptPath`). */
const IDENTITY_PATH = "IDENTITY.md";

/**
 * The `- **Name:**` line the daemon parses (`parseIdentityFields` matches the
 * label case-insensitively). Capture the label prefix so we preserve its
 * original casing/indentation and only swap the value.
 */
const NAME_LINE = /^([ \t]*-[ \t]*\*\*name:\*\*[ \t]*).*$/im;

/**
 * Best-effort: rewrite the `- **Name:**` value in `IDENTITY.md` to `name`.
 * No-ops (and never throws) when the file is missing or has no Name line yet —
 * the optimistic pending name still covers the UI in that window.
 */
export async function persistCastAssistantName(
  assistantId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;

  try {
    const { data, response } = await workspaceFileGet({
      path: { assistant_id: assistantId },
      query: { path: IDENTITY_PATH },
      throwOnError: false,
    });
    if (!response?.ok || data?.isBinary || typeof data?.content !== "string") {
      return;
    }
    const content = data.content;
    if (!NAME_LINE.test(content)) return;

    const next = content.replace(NAME_LINE, `$1${trimmed}`);
    if (next === content) return;

    await workspaceWritePost({
      path: { assistant_id: assistantId },
      body: { path: IDENTITY_PATH, content: next },
      throwOnError: false,
    });
  } catch (err) {
    captureError(err, { context: "persistCastAssistantName" });
  }
}
