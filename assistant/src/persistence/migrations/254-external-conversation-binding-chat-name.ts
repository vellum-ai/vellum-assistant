import type { DrizzleDb } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

export function migrateExternalConversationBindingChatName(
  database: DrizzleDb,
): void {
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
