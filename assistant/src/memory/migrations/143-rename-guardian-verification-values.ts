import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Reverse v23: add the "guardian_" prefix back to verification-related
 * call_mode and event_type values.
 */
export function downRenameGuardianVerificationValues(
  database: DrizzleDb,
): void {
  const raw = getSqliteFrom(database);

  // Rename call_mode values back
  raw.exec(
    /*sql*/ `UPDATE call_sessions SET call_mode = 'guardian_verification' WHERE call_mode = 'verification'`,
  );

  // Rename event_type values back
  raw.exec(
    /*sql*/ `UPDATE call_events SET event_type = 'guardian_voice_verification_started' WHERE event_type = 'voice_verification_started'`,
  );
  raw.exec(
    /*sql*/ `UPDATE call_events SET event_type = 'guardian_voice_verification_succeeded' WHERE event_type = 'voice_verification_succeeded'`,
  );
  raw.exec(
    /*sql*/ `UPDATE call_events SET event_type = 'guardian_voice_verification_failed' WHERE event_type = 'voice_verification_failed'`,
  );
  raw.exec(
    /*sql*/ `UPDATE call_events SET event_type = 'outbound_guardian_voice_verification_started' WHERE event_type = 'outbound_voice_verification_started'`,
  );
  raw.exec(
    /*sql*/ `UPDATE call_events SET event_type = 'outbound_guardian_voice_verification_succeeded' WHERE event_type = 'outbound_voice_verification_succeeded'`,
  );
  raw.exec(
    /*sql*/ `UPDATE call_events SET event_type = 'outbound_guardian_voice_verification_failed' WHERE event_type = 'outbound_voice_verification_failed'`,
  );
}

/**
 * One-shot migration: rename persisted `guardian_verification` and
 * `guardian_voice_verification_*` / `outbound_guardian_voice_verification_*`
 * values in the call_sessions and call_events tables to drop the "guardian_"
 * prefix, aligning with the broader verification vocabulary.
 *
 * - call_sessions.call_mode: "guardian_verification" -> "verification"
 * - call_events.event_type: six guardian_voice_verification_* values renamed
 */
export function migrateRenameGuardianVerificationValues(
  database: DrizzleDb,
): void {
  withCrashRecovery(
    database,
    "migration_rename_guardian_verification_values_v1",
    () => {
      const raw = getSqliteFrom(database);

      // Rename call_mode values
      raw.exec(
        /*sql*/ `UPDATE call_sessions SET call_mode = 'verification' WHERE call_mode = 'guardian_verification'`,
      );

      // Rename event_type values
      raw.exec(
        /*sql*/ `UPDATE call_events SET event_type = 'voice_verification_started' WHERE event_type = 'guardian_voice_verification_started'`,
      );
      raw.exec(
        /*sql*/ `UPDATE call_events SET event_type = 'voice_verification_succeeded' WHERE event_type = 'guardian_voice_verification_succeeded'`,
      );
      raw.exec(
        /*sql*/ `UPDATE call_events SET event_type = 'voice_verification_failed' WHERE event_type = 'guardian_voice_verification_failed'`,
      );
      raw.exec(
        /*sql*/ `UPDATE call_events SET event_type = 'outbound_voice_verification_started' WHERE event_type = 'outbound_guardian_voice_verification_started'`,
      );
      raw.exec(
        /*sql*/ `UPDATE call_events SET event_type = 'outbound_voice_verification_succeeded' WHERE event_type = 'outbound_guardian_voice_verification_succeeded'`,
      );
      raw.exec(
        /*sql*/ `UPDATE call_events SET event_type = 'outbound_voice_verification_failed' WHERE event_type = 'outbound_guardian_voice_verification_failed'`,
      );
    },
  );
}
