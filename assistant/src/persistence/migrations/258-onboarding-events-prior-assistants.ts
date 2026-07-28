import type { DrizzleDb } from "../db-connection.js";

export function migrateOnboardingEventsPriorAssistants(
  database: DrizzleDb,
): void {
  try {
    database.run(
      /*sql*/ `ALTER TABLE onboarding_events ADD COLUMN prior_assistants_json TEXT`,
    );
  } catch {
    /* already exists */
  }
}
