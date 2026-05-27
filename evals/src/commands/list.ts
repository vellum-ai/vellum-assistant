/** Catalog list commands. */
import type { Command } from "commander";

import { loadBenchmark } from "../lib/benchmark";
import {
  listBenchmarkIds,
  listBenchmarkUnitIds,
  listProfileIds,
  listTestIds,
} from "../lib/catalog";
import { loadProfile } from "../lib/profile";
import { loadTestDef } from "../lib/test-def";

interface ListOptions {
  json?: boolean;
}

function printRows(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log("No entries found.");
    return;
  }

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const format = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  console.log(format(headers));
  console.log(format(widths.map((width) => "-".repeat(width))));
  rows.forEach((row) => console.log(format(row)));
}

export function registerListCommands(program: Command): void {
  const profiles = program
    .command("profiles")
    .description("Inspect eval profiles");

  profiles
    .command("list")
    .description("List available eval profiles")
    .option("--json", "Print JSON")
    .action(async (opts: ListOptions) => {
      const items = await Promise.all(
        (await listProfileIds()).map(async (id) => {
          const profile = await loadProfile(id);
          return {
            id: profile.id,
            species: profile.manifest.species,
            version: profile.manifest.version ?? null,
            setupCommands: Array.isArray(profile.manifest.setup)
              ? profile.manifest.setup.length
              : profile.manifest.setup === undefined
                ? 0
                : 1,
          };
        }),
      );

      if (opts.json) {
        console.log(JSON.stringify({ profiles: items }, null, 2));
        return;
      }

      printRows(
        ["profile", "species", "version", "setup"],
        items.map((item) => [
          item.id,
          item.species,
          item.version ?? "-",
          String(item.setupCommands),
        ]),
      );
    });

  const benchmarks = program
    .command("benchmarks")
    .description("Inspect eval benchmarks");

  benchmarks
    .command("list")
    .description("List available benchmarks")
    .option("--json", "Print JSON")
    .action(async (opts: ListOptions) => {
      const items = await Promise.all(
        (await listBenchmarkIds()).map(async (id) => {
          const benchmark = await loadBenchmark(id);
          const units = await listBenchmarkUnitIds(benchmark.unitsDir);
          return {
            id: benchmark.id,
            displayName: benchmark.manifest.displayName,
            unitNoun: benchmark.manifest.unitNoun,
            units: units.length,
          };
        }),
      );

      if (opts.json) {
        console.log(JSON.stringify({ benchmarks: items }, null, 2));
        return;
      }

      printRows(
        ["benchmark", "display", "unit", "count"],
        items.map((item) => [
          item.id,
          item.displayName,
          item.unitNoun,
          String(item.units),
        ]),
      );
    });

  const tests = program
    .command("tests")
    .description(
      `Inspect eval tests (personal-intelligence benchmark only — see \`evals benchmarks list\` for other benchmarks)`,
    );

  tests
    .command("list")
    .description(
      "List available eval tests for the personal-intelligence benchmark",
    )
    .option("--json", "Print JSON")
    .action(async (opts: ListOptions) => {
      const items = await Promise.all(
        (await listTestIds()).map(async (id) => {
          const test = await loadTestDef(id);
          return {
            id: test.id,
            metrics: test.metricPaths.length,
            setupCommands: test.setupCommands.length,
          };
        }),
      );

      if (opts.json) {
        console.log(JSON.stringify({ tests: items }, null, 2));
        return;
      }

      printRows(
        ["test", "metrics", "setup"],
        items.map((item) => [
          item.id,
          String(item.metrics),
          String(item.setupCommands),
        ]),
      );
    });
}
