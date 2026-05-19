/**
 * Tests for AutoTopUpDisableConfirm. The web workspace doesn't pull in
 * @testing-library/react, so we pin the component's copy at the source
 * level — both the modal title/body and the in-flight vs. at-rest
 * confirm-label variants. If any literal drifts, the test fails and forces
 * a conscious copy update.
 */

import { describe, expect, test } from "bun:test";

import { AutoTopUpDisableConfirm } from "@/components/app/settings/AutoTopUpDisableConfirm.js";

describe("AutoTopUpDisableConfirm", () => {
  test("exports a function component", () => {
    expect(typeof AutoTopUpDisableConfirm).toBe("function");
  });

  test("source pins title, body, and both confirm-label variants verbatim", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "AutoTopUpDisableConfirm.tsx"),
      "utf-8",
    );
    expect(source).toContain('"Disable automatic top-ups?"');
    expect(source).toContain(
      '"Auto top-ups will stop. Any saved payment method stays on file."',
    );
    expect(source).toContain('"Keep enabled"');
    // Confirm label flips on `confirming` — pin both variants.
    expect(source).toContain('"Disabling…"');
    expect(source).toContain('"Disable"');
  });
});
