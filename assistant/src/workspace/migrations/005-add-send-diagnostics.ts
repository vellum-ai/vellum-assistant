import type { WorkspaceMigration } from "./types.js";

export const addSendDiagnosticsMigration: WorkspaceMigration = {
  id: "005-add-send-diagnostics",
  description:
    "Add sendDiagnostics config key (defaults to true, no data to migrate from UserDefaults)",
  run(_workspaceDir: string): void {
    // No-op — the schema default handles new installs, and the macOS client
    // will sync the UserDefaults value on first startup. This migration exists
    // as a checkpoint marker for future reference.
  },
  down(_workspaceDir: string): void {
    // No-op — the forward migration is a checkpoint marker with no data changes.
  },
};
