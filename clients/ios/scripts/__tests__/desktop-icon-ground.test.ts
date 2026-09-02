/**
 * Drift guard tying the desktop icon grounds to the iOS bundles.
 *
 * macOS and Linux each keep their own copy of the same Icon Composer manifests,
 * and a hand edit to one mirror leaves the two platforms shipping different
 * greens. The manifests also carry the same Display P3 encoding the iOS bundles
 * do, so an environment's ground is one value across every client. Windows has
 * no manifest to pin: it ships committed per-environment ICO assets, and their
 * parity is held by generating them from these strings plus the `clients/windows`
 * identity test, which asserts a distinct valid ICO per environment.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENTS_DIR = join(import.meta.dir, "../../..");

/** Every environment with a desktop icon manifest. */
const ENVIRONMENTS = ["production", "staging", "dev", "local"] as const;

/** The environments the standard palette covers, and their iOS bundle. */
const STANDARDIZED = [
  { environment: "production", icon: "AppIcon.icon" },
  { environment: "staging", icon: "AppIcon-Staging.icon" },
  { environment: "dev", icon: "AppIcon-Dev.icon" },
] as const;

const P3_SPELLING = /^display-p3:\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+$/;

/** The desktop manifests keep the fill at the top level, not per appearance. */
function readDesktopFill(platform: string, environment: string): string {
  const path = join(
    CLIENTS_DIR,
    platform,
    "build-resources/icons",
    environment,
    "icon.json",
  );
  return JSON.parse(readFileSync(path, "utf8")).fill.solid;
}

/** The bundle pins every appearance to one color, so any specialization does. */
function readIosFill(icon: string): string {
  const path = join(CLIENTS_DIR, "ios/App/App", icon, "icon.json");
  const solids = new Set(
    JSON.parse(readFileSync(path, "utf8"))["fill-specializations"].map(
      ({ value }: { value: { solid: string } }) => value.solid,
    ),
  );
  expect(solids.size).toBe(1);
  return [...solids][0] as string;
}

describe("desktop icon ground", () => {
  for (const environment of ENVIRONMENTS) {
    test(`${environment} reads the same on macOS and Linux`, () => {
      expect(readDesktopFill("macos", environment)).toBe(
        readDesktopFill("linux", environment),
      );
    });
  }

  for (const { environment, icon } of STANDARDIZED) {
    test(`${environment} matches ${icon}`, () => {
      expect(readDesktopFill("macos", environment)).toBe(readIosFill(icon));
    });
  }

  test("local keeps its own ground in the spelling the renderers parse", () => {
    expect(readDesktopFill("macos", "local")).toMatch(P3_SPELLING);
  });

  test("the four grounds are actually different", () => {
    const grounds = ENVIRONMENTS.map((environment) =>
      readDesktopFill("macos", environment),
    );
    expect(new Set(grounds).size).toBe(ENVIRONMENTS.length);
  });
});
