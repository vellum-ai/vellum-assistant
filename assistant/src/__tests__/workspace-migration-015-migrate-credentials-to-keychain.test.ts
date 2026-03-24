import { describe, expect, test } from "bun:test";

import { migrateCredentialsToKeychainMigration } from "../workspace/migrations/015-migrate-credentials-to-keychain.js";

describe("015-migrate-credentials-to-keychain migration", () => {
  test("has correct migration id", () => {
    expect(migrateCredentialsToKeychainMigration.id).toBe(
      "015-migrate-credentials-to-keychain",
    );
  });

  test("run is a no-op", async () => {
    await migrateCredentialsToKeychainMigration.run("/fake");
  });

  test("down is a no-op", async () => {
    await migrateCredentialsToKeychainMigration.down("/fake");
  });
});
