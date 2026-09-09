/**
 * Shared readers for the Icon Composer bundles the drift guards pin against.
 *
 * Both guards read the same bundles, so the reader lives here rather than once
 * per test: a bundle that changes shape then breaks one function instead of
 * drifting between two copies of it.
 */
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(import.meta.dir, "../../App/App");

/** The spelling both the Swift parser and the desktop renderers read. */
export const P3_SPELLING = /^display-p3:\d+\.\d+,\d+\.\d+,\d+\.\d+,\d+\.\d+$/;

export interface FillSpecialization {
  appearance?: string;
  value: { solid: string };
}

export function readFillSpecializations(icon: string): FillSpecialization[] {
  const contents = readFileSync(join(APP_DIR, icon, "icon.json"), "utf8");
  return JSON.parse(contents)["fill-specializations"];
}

/** The bundle pins every appearance to one color, so any specialization does. */
export function readIconFill(icon: string): string {
  const solids = new Set(
    readFillSpecializations(icon).map(({ value }) => value.solid),
  );
  expect(solids.size).toBe(1);
  return [...solids][0] as string;
}
