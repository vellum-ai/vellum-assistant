import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-074-drop-deprecated-secret-detection-keys",
);

const MIGRATION_ID = "074-drop-deprecated-secret-detection-keys";
const NOTICE_MARKER = `<!-- release-note-id:${MIGRATION_ID} -->`;

function buildNotice(previousAction: string): string {
  return `${NOTICE_MARKER}
## Heads-up: tool-output secret scanning was retired

Your previous \`secretDetection.action\` setting was \`"${previousAction}"\`,
which used to gate or redact tool output containing high-entropy strings or
matches against custom regex patterns. That post-execution scanning layer has
been removed because it was false-positive prone and prevented the assistant
from acting on values it had legitimately fetched.

Prefix-based ingress detection on user messages is still active
(\`secretDetection.enabled\` / \`secretDetection.blockIngress\`), and the
\`secretDetection.entropyThreshold\` and \`secretDetection.customPatterns\`
fields have been removed from your config. If you relied on the old behavior,
please reach out so we can find a better solution for your use case.
`;
}

export const dropDeprecatedSecretDetectionKeysMigration: WorkspaceMigration = {
  id: MIGRATION_ID,
  description:
    "Strip removed secretDetection.action / entropyThreshold / customPatterns keys; notify users who had a non-default action policy",

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const secretDetection = readObject(config.secretDetection);
    if (secretDetection === null) return;

    const previousAction =
      typeof secretDetection.action === "string"
        ? secretDetection.action
        : null;

    let mutated = false;
    for (const key of ["action", "entropyThreshold", "customPatterns"]) {
      if (key in secretDetection) {
        delete secretDetection[key];
        mutated = true;
      }
    }

    if (mutated) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }

    if (previousAction === "block" || previousAction === "prompt") {
      appendNotice(workspaceDir, previousAction);
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: restoring the deleted keys would re-introduce schema
    // warnings without changing runtime behavior — the post-execution scanner
    // they used to drive no longer exists.
  },
};

function appendNotice(workspaceDir: string, previousAction: string): void {
  const updatesPath = join(workspaceDir, "UPDATES.md");
  const notice = buildNotice(previousAction);

  try {
    if (existsSync(updatesPath)) {
      const existing = readFileSync(updatesPath, "utf-8");
      if (existing.includes(NOTICE_MARKER)) return;
      const prefix = existing.endsWith("\n") ? "\n" : "\n\n";
      appendFileSync(updatesPath, `${prefix}${notice}`, "utf-8");
    } else {
      writeFileSync(updatesPath, notice, "utf-8");
    }
    log.info(
      { path: updatesPath, previousAction },
      "Appended secret-detection retirement notice",
    );
  } catch (err) {
    log.warn(
      { err, path: updatesPath, previousAction },
      "Failed to append secret-detection retirement notice to UPDATES.md",
    );
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
