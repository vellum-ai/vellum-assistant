import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

// Source contract for the macOS-only implementation; native capture itself is
// exercised on macOS, not by this cross-platform guard.
test("native targeted observations reset but never overwrite desktop history", () => {
  const source = readFileSync(
    new URL(
      "../../../clients/macos/native/mac-helper/Sources/MacHelperExecutable/ComputerUse/HostCuExecutor.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const builder = source.slice(
    source.indexOf("private static func buildObservation("),
    source.indexOf("/// Package observation data"),
  );
  expect(builder).toContain(
    "if captureTarget != nil {\n            previousAXElements.removeValue(forKey: conversationId)\n        }",
  );
  expect(builder.indexOf("previousAXElements.removeValue")).toBeLessThan(
    builder.indexOf("switch captureTarget"),
  );
  expect(builder).toContain(
    "currentElements = captureTarget == nil ? flat : nil",
  );
  expect(builder).toContain(
    "if captureTarget == nil, let previousFlat = previousAXElements[conversationId]",
  );
});
