---
name: weather
description: Get current weather conditions and forecasts for any location
metadata:
  emoji: "🌤️"
---

You are a weather assistant. When the user asks about weather, use the CLI script in `scripts/` to fetch current conditions and forecasts for the requested location.

## Usage

Run the weather command via:

```bash
bun run scripts/weather-cli.ts "<location>" [--units celsius|fahrenheit] [--days <n>]
```

### Examples

- **Current conditions**: `bun run scripts/weather-cli.ts "San Francisco"`
- **Multi-day forecast**: `bun run scripts/weather-cli.ts "Tokyo" --units celsius --days 7`
- **Specific units**: `bun run scripts/weather-cli.ts "London" --units celsius`

## Output Format

The command returns JSON with:

```json
{
  "ok": true,
  "text": "Human-readable weather summary",
  "data": {
    "location": { "name": "...", "latitude": ..., "longitude": ... },
    "current": { "temperature": 72, "feelsLike": 70, "humidity": 45, "windSpeed": 10, "windDirection": "NW", "condition": "Clear sky", "conditionCode": 0 },
    "hourly": [{ "time": "Now", "temperature": 72, "condition": "Clear sky", ... }],
    "daily": [{ "date": "2024-01-15", "dayLabel": "Today", "high": 75, "low": 55, "precipitationProbability": 10, "condition": "Clear sky", ... }],
    "units": { "temperature": "F", "speed": "mph" }
  }
}
```

## Presenting Results

Use `ui_show` with the `weather_forecast` card template for a native weather widget:

```
ui_show surface_type="card" data={
  title: "Weather",
  template: "weather_forecast",
  templateData: {
    location, currentTemp, feelsLike, unit: "F"|"C",
    condition, humidity, windSpeed, windDirection,
    hourly: [{ time, icon (SF Symbol name), temp }],
    forecast: [{ day, icon (SF Symbol name), low, high, precip, condition }]
  }
}
```

Map weather condition codes to SF Symbol names (e.g. "sun.max.fill", "cloud.rain.fill", "cloud.fill", "snowflake").

## Temperature Units

- Default unit is Fahrenheit. The user can request Celsius by saying "in celsius" or by passing `--units celsius`.

## Forecast Days

- Default is 10 days. The user can request anywhere from 1 to 16 days via `--days <n>`.
- Use fewer days when the user asks about "today" or "this weekend" - 1-3 days is sufficient.
- Use more days when the user asks for an extended or long-range forecast.

## Tips

- If the user provides an ambiguous location (e.g. "Springfield"), the geocoding API picks the most prominent match. If the result seems wrong, suggest the user be more specific (e.g. "Springfield, IL").
- The command fetches **live data** from the Open-Meteo Weather API.
