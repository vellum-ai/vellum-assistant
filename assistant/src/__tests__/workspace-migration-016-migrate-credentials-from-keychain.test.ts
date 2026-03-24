import { describe, expect, test } from "bun:test";

import { migrateCredentialsFromKeychainMigration } from "../workspace/migrations/016-migrate-credentials-from-keychain.js";

describe("016-migrate-credentials-from-keychain migration", () => {
  test("has correct migration id", () => {
    expect(migrateCredentialsFromKeychainMigration.id).toBe(
      "016-migrate-credentials-from-keychain",
    );
  });

  test("run is a no-op", async () => {
    await migrateCredentialsFromKeychainMigration.run("/fake");
  });

  test("down is a no-op", async () => {
    await migrateCredentialsFromKeychainMigration.down("/fake");
  });
});
