import { initializeDb } from "./db-init.js";

try {
  await initializeDb({ failOnMigrationErrors: true });
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
