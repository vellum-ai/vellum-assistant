/**
 * Drift guard for the app-icon ground the widget extension draws.
 *
 * The widgets' New Chat surfaces draw the containing app's mark when no avatar
 * has synced, which is the state the widget gallery renders. The ground under
 * that mark cannot be a literal in Swift: the three environments ship three
 * different icons, so a literal would advertise the production green on a Dev
 * build. Each target carries its own `APP_ICON_GROUND` instead, and this test
 * pins those to the Icon Composer bundle each target actually ships.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "../../App/App");

/** Each extension xcconfig, and the icon bundle its target ships. */
const TARGETS = [
  { xcconfig: "Extension.xcconfig", icon: "AppIcon.icon" },
  { xcconfig: "Extension-Dev.xcconfig", icon: "AppIcon-Dev.icon" },
  { xcconfig: "Extension-Staging.xcconfig", icon: "AppIcon-Staging.icon" },
];

function readGround(xcconfig: string): string | undefined {
  const contents = readFileSync(join(APP_DIR, "Config", xcconfig), "utf8");
  return /^APP_ICON_GROUND\s*=\s*(.+)$/m.exec(contents)?.[1]?.trim();
}

interface FillSpecialization {
  appearance?: string;
  value: { solid: string };
}

function readFillSpecializations(icon: string): FillSpecialization[] {
  const contents = readFileSync(join(APP_DIR, icon, "icon.json"), "utf8");
  return JSON.parse(contents)["fill-specializations"];
}

/** The bundle pins every appearance to one color, so any specialization does. */
function readIconFill(icon: string): string {
  const solids = new Set(
    readFillSpecializations(icon).map(({ value }) => value.solid),
  );
  expect(solids.size).toBe(1);
  return [...solids][0] as string;
}

describe("ios app icon ground", () => {
  for (const { xcconfig, icon } of TARGETS) {
    test(`${xcconfig} carries ${icon}'s own fill`, () => {
      expect(readGround(xcconfig)).toBe(readIconFill(icon));
    });
  }

  for (const { icon } of TARGETS) {
    test(`${icon} pins its dark appearance to the same fill`, () => {
      const appearances = readFillSpecializations(icon).map(
        ({ appearance }) => appearance,
      );
      expect(appearances).toContain("dark");
    });
  }

  test("the three grounds are actually different", () => {
    const grounds = TARGETS.map(({ xcconfig }) => readGround(xcconfig));
    expect(new Set(grounds).size).toBe(TARGETS.length);
  });

  test("every ground is the spelling the Swift parser reads", () => {
    for (const { xcconfig } of TARGETS) {
      expect(readGround(xcconfig)).toMatch(
        /^display-p3:\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+$/,
      );
    }
  });
});
