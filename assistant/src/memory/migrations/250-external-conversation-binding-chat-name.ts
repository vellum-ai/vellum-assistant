import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

const CHECKPOINT_KEY = "migration_external_conversation_binding_chat_name_v1";

export function migrateExternalConversationBindingChatName(
  database: DrizzleDb,
): void {
  withCrashRecovery(database, CHECKPOINT_KEY, () => {
    if (
      tableHasColumn(
        database,
        "external_conversation_bindings",
        "external_chat_name",
      )
    ) {
      return;
    }

    database.run(
      `ALTER TABLE external_conversation_bindings ADD COLUMN external_chat_name TEXT`,
    );
  });
}

export function downExternalConversationBindingChatName(
  database: DrizzleDb,
): void {
  if (
    !tableHasColumn(
      database,
      "external_conversation_bindings",
      "external_chat_name",
    )
  ) {
    return;
  }

  database.run(
    `ALTER TABLE external_conversation_bindings DROP COLUMN external_chat_name`,
  );
}
