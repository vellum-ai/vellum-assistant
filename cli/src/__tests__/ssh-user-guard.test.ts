import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Regression guard for PR #25292: hatchAws/hatchGcp must abort before
// launching a cloud instance when sshUser is empty. Otherwise `useradd ""`
// in the generated startup script fails after billable resources are live.
describe("sshUser empty-string guard", () => {
  const files = [
    join(import.meta.dir, "..", "lib", "aws.ts"),
    join(import.meta.dir, "..", "lib", "gcp.ts"),
  ];

  for (const file of files) {
    test(`${file.split("/").slice(-2).join("/")} aborts on empty sshUser`, () => {
      const source = readFileSync(file, "utf8");
      const fallbackIdx = source.indexOf('sshUser = process.env.USER ?? ""');
      expect(fallbackIdx).toBeGreaterThan(-1);

      const afterFallback = source.slice(fallbackIdx);
      const guardIdx = afterFallback.search(/if\s*\(\s*!sshUser\s*\)/);
      expect(guardIdx).toBeGreaterThan(-1);

      const guardBlock = afterFallback.slice(guardIdx, guardIdx + 400);
      expect(guardBlock).toContain("process.exit(1)");
    });
  }
});
