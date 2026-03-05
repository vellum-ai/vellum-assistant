#!/usr/bin/env bun
/**
 * CLI for weather skill: `bun run scripts/weather-cli.ts`
 *
 * Fetches current weather conditions and forecasts from Open-Meteo.
 * All commands output JSON to stdout. Use --json for machine-readable output.
 */

import { executeGetWeather } from "./service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + "\n" : JSON.stringify(data, null, 2) + "\n",
  );
}

function outputError(message: string, code = 1): void {
  output({ ok: false, error: message }, true);
  process.exitCode = code;
}

function printUsage(): void {
  process.stderr.write(`Usage: bun run scripts/weather-cli.ts <location> [options]

Get current weather conditions and forecast for a location.

Arguments:
  <location>           Location to get weather for (city name, address, etc.)

Options:
  --units <unit>       Temperature units: celsius or fahrenheit (default: fahrenheit)
  --days <n>           Number of forecast days (1-16, default: 10)
  --json               Machine-readable JSON output

Examples:
  bun run scripts/weather-cli.ts "San Francisco" --json
  bun run scripts/weather-cli.ts "Tokyo" --units celsius --days 7 --json
  bun run scripts/weather-cli.ts "London, UK" --json
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
  location: string;
  units: "celsius" | "fahrenheit";
  days: number;
  json: boolean;
  help: boolean;
} {
  let location = "";
  let units: "celsius" | "fahrenheit" = "fahrenheit";
  let days = 10;
  let json = false;
  let help = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
      i++;
    } else if (arg === "--json") {
      json = true;
      i++;
    } else if (arg === "--units" && i + 1 < args.length) {
      const val = args[i + 1];
      if (val === "celsius" || val === "fahrenheit") {
        units = val;
      } else {
        outputError('Invalid units. Use "celsius" or "fahrenheit".');
        process.exit(1);
      }
      i += 2;
    } else if (arg === "--days" && i + 1 < args.length) {
      days = parseInt(args[i + 1], 10);
      if (isNaN(days) || days < 1 || days > 16) {
        outputError("Invalid days. Must be between 1 and 16.");
        process.exit(1);
      }
      i += 2;
    } else if (!arg.startsWith("-")) {
      location = arg;
      i++;
    } else {
      outputError(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return { location, units, days, json, help };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const { location, units, days, json, help } = parseArgs(args);

  if (help) {
    printUsage();
    process.exit(0);
  }

  if (!location) {
    outputError("Location is required");
    printUsage();
    process.exit(1);
  }

  try {
    const result = await executeGetWeather(
      { location, units, days },
      globalThis.fetch,
      // No proxy resolver - CLI mode doesn't auto-emit UI surfaces
      undefined,
    );

    if (result.isError) {
      outputError(result.content);
    } else {
      // Parse the text output and structure it for JSON
      // The service returns text format - we'll pass it through
      if (json) {
        output({ ok: true, weather: result.content }, true);
      } else {
        // Pretty print for human consumption
        process.stdout.write(result.content + "\n");
      }
    }
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }
}

main();
