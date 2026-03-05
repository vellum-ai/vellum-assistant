---
name: "weather"
description: "Get current weather conditions and forecasts for any location"
metadata:
  emoji: "\ud83c\udf24\ufe0f"
  vellum:
    cli:
      command: "weather"
      entry: "scripts/weather-cli.ts"
---

You are a weather assistant. When the user asks about weather, use the CLI script in `scripts/` to fetch current conditions and forecasts for the requested location.

## Usage

Run the weather command via:

```bash
bun run scripts/weather-cli.ts "<location>" [--units celsius|fahrenheit] [--days <n>] --json
```

### Examples

- **Current conditions**: `bun run scripts/weather-cli.ts "San Francisco" --json`
- **Multi-day forecast**: `bun run scripts/weather-cli.ts "Tokyo" --units celsius --days 7 --json`
- **Specific units**: `bun run scripts/weather-cli.ts "London" --units celsius --json`

## Understanding the Output

The command returns:

- **Current conditions** — temperature, feels-like temperature, humidity, wind speed and direction, and a description of conditions (e.g. "Partly cloudy")
- **Hourly forecast** — next 24 hours of temperature and conditions
- **Daily forecast** — high/low temperatures, precipitation probability, and conditions for each day

## Temperature Units

- Default unit is Fahrenheit. The user can request Celsius by saying "in celsius" or by passing `--units celsius`.

## Forecast Days

- Default is 10 days. The user can request anywhere from 1 to 16 days via `--days <n>`.
- Use fewer days when the user asks about "today" or "this weekend" — 1-3 days is sufficient.
- Use more days when the user asks for an extended or long-range forecast.

## Tips

- If the user provides an ambiguous location (e.g. "Springfield"), the geocoding API picks the most prominent match. If the result seems wrong, suggest the user be more specific (e.g. "Springfield, IL").
- The command fetches **live data** from the Open-Meteo Weather API.
- Always use `--json` flag for reliable parsing.
