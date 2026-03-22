import type { WorkspaceMigration } from "./types.js";

export const voiceTimeoutAndMaxStepsMigration: WorkspaceMigration = {
  id: "008-voice-timeout-and-max-steps",
  description:
    "Add elevenlabs.conversationTimeoutSeconds and maxStepsPerSession to config schema (defaults handle new installs; macOS client syncs existing UserDefaults values on startup)",
  run(_workspaceDir: string): void {
    // No-op — schema defaults handle new installs.
    // Existing users: macOS client will sync UserDefaults values
    // to config on next startup via settings sync endpoints.
  },
  down(_workspaceDir: string): void {
    // No-op — the forward migration is a checkpoint marker with no data changes.
  },
};
