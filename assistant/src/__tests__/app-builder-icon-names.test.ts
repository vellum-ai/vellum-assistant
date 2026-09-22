/**
 * The app-builder skill lists the icon names a model may put in
 * `preview.icon`, and `@vellumai/app-icons` is what the executor accepts.
 * The skill is prose, so nothing types it against the package; this pins
 * the two lists to each other.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { APP_ICON_NAMES } from "@vellumai/app-icons";

const SKILL_PATH = join(
  import.meta.dir,
  "../config/bundled-skills/app-builder/SKILL.md",
);

describe("app-builder skill icon names", () => {
  test("lists exactly the registry's names, in its order", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");
    const line = skill
      .split("\n")
      .find((l) => l.startsWith("**App icon names**"));
    expect(line).toBeDefined();
    const listed = [...line!.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    expect(listed).toEqual([...APP_ICON_NAMES]);
  });
});
