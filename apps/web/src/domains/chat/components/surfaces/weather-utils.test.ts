import { describe, expect, test } from "bun:test";
import { Cloud, CloudRain, Moon, Snowflake, Sun, Wind } from "lucide-react";

import {
  displayTemp,
  getDayHigh,
  getDayLow,
  getHourlyTemp,
  getWeatherIcon,
  parseWeatherData,
} from "@/domains/chat/components/surfaces/weather-utils";

// ---------------------------------------------------------------------------
// getWeatherIcon
// ---------------------------------------------------------------------------

describe("getWeatherIcon", () => {
  test("matches SF Symbol strings exactly", () => {
    expect(getWeatherIcon("sun.max.fill").icon).toBe(Sun);
    expect(getWeatherIcon("cloud.rain.fill").icon).toBe(CloudRain);
    expect(getWeatherIcon("moon.fill").icon).toBe(Moon);
    expect(getWeatherIcon("snowflake").icon).toBe(Snowflake);
  });

  test("matches condition strings case-insensitively", () => {
    expect(getWeatherIcon("Sunny").icon).toBe(Sun);
    expect(getWeatherIcon("RAIN").icon).toBe(CloudRain);
    expect(getWeatherIcon("Snow").icon).toBe(Snowflake);
    expect(getWeatherIcon("Windy").icon).toBe(Wind);
  });

  test("matches condition substring when no exact match", () => {
    expect(getWeatherIcon("light rain showers").icon).toBe(CloudRain);
    expect(getWeatherIcon("heavy snow expected").icon).toBe(Snowflake);
  });

  test("returns default cloud icon for unrecognized strings", () => {
    expect(getWeatherIcon("unknown-condition").icon).toBe(Cloud);
    expect(getWeatherIcon("").icon).toBe(Cloud);
  });

  test("returns decorative color classes (not semantic tokens)", () => {
    expect(getWeatherIcon("sun.max.fill").className).toBe("text-orange-500");
    expect(getWeatherIcon("snowflake").className).toBe("text-blue-300");
  });
});
// ---------------------------------------------------------------------------
// parseWeatherData
// ---------------------------------------------------------------------------

describe("parseWeatherData", () => {
  test("returns null when location is missing", () => {
    expect(parseWeatherData({ currentTemp: 72 })).toBeNull();
  });

  test("parses minimal valid payload (string location)", () => {
    const result = parseWeatherData({ location: "San Francisco" });
    expect(result).not.toBeNull();
    expect(result!.location).toBe("San Francisco");
  });

  test("normalizes object location to string", () => {
    const result = parseWeatherData({ location: { name: "Tokyo" } });
    expect(result).not.toBeNull();
    expect(result!.location).toBe("Tokyo");
  });

  test("parses top-level temperature fields", () => {
    const result = parseWeatherData({
      location: "NYC",
      currentTemp: 72,
      feelsLike: 68,
      condition: "Sunny",
      humidity: 45,
    });
    expect(result!.currentTemp).toBe(72);
    expect(result!.feelsLike).toBe(68);
    expect(result!.condition).toBe("Sunny");
    expect(result!.humidity).toBe(45);
  });

  test("prefers nested current object over top-level fields", () => {
    const result = parseWeatherData({
      location: "NYC",
      temp: 60,
      current: { temp: 72, condition: "Clear" },
    });
    expect(result!.currentTemp).toBe(72);
    expect(result!.condition).toBe("Clear");
  });

  test("parses wind from numeric fields", () => {
    const result = parseWeatherData({
      location: "NYC",
      windSpeed: 15,
      windDirection: "NW",
    });
    expect(result!.windSpeed).toBe(15);
    expect(result!.windDirection).toBe("NW");
  });

  test("parses wind from string format (e.g. '15 mph NW')", () => {
    const result = parseWeatherData({
      location: "NYC",
      wind: "15 mph NW",
    });
    expect(result!.windSpeed).toBe(15);
    expect(result!.windDirection).toBe("NW");
  });

  test("defaults unit to F when not specified", () => {
    const result = parseWeatherData({ location: "NYC" });
    expect(result!.unit).toBe("F");
  });

  test("reads unit from units.temperature", () => {
    const result = parseWeatherData({
      location: "NYC",
      units: { temperature: "C" },
    });
    expect(result!.unit).toBe("C");
  });

  test("reads wind unit from units.speed", () => {
    const result = parseWeatherData({
      location: "NYC",
      windSpeed: 18,
      units: { temperature: "C", speed: "km/h" },
    });
    expect(result!.windUnit).toBe("km/h");
  });

  test("defaults windUnit to undefined when not specified", () => {
    const result = parseWeatherData({ location: "NYC", windSpeed: 10 });
    expect(result!.windUnit).toBeUndefined();
  });

  test("normalizes hourly temp to single field (prefers tempC)", () => {
    const result = parseWeatherData({
      location: "NYC",
      hourly: [
        { time: "Now", icon: "sun.max.fill", tempC: 22, temp: 72, temperature: 72 },
        { time: "1PM", icon: "cloud.fill", temp: 68 },
        { time: "2PM", icon: "cloud.fill", temperature: 65 },
      ],
    });
    const hourly = result!.hourly!;
    expect(hourly).toHaveLength(3);
    // tempC takes precedence — temp field gets the tempC value
    expect(hourly[0].temp).toBe(22);
    expect(hourly[0].tempC).toBe(22);
    // Falls back to temp
    expect(hourly[1].temp).toBe(68);
    // Falls back to temperature
    expect(hourly[2].temp).toBe(65);
  });

  test("normalizes precip to single field", () => {
    const result = parseWeatherData({
      location: "NYC",
      forecast: [
        { day: "Mon", icon: "cloud.fill", precip: 30 },
        { day: "Tue", icon: "cloud.fill", precipitation: 50 },
        { day: "Wed", icon: "cloud.fill", precipitationProbability: 70 },
      ],
    });
    const forecast = result!.forecast!;
    expect(forecast[0].precip).toBe(30);
    expect(forecast[1].precip).toBe(50);
    expect(forecast[2].precip).toBe(70);
  });

  test("accepts daily and days arrays as aliases for forecast", () => {
    const daily = parseWeatherData({
      location: "NYC",
      daily: [{ day: "Mon", icon: "sun.max.fill" }],
    });
    expect(daily!.forecast).toHaveLength(1);

    const days = parseWeatherData({
      location: "NYC",
      days: [{ day: "Mon", icon: "sun.max.fill" }],
    });
    expect(days!.forecast).toHaveLength(1);
  });

  test("falls through to daily when forecast is non-array", () => {
    const result = parseWeatherData({
      location: "NYC",
      forecast: "malformed",
      daily: [{ day: "Mon", icon: "sun.max.fill" }],
    });
    expect(result!.forecast).toHaveLength(1);
    expect(result!.forecast![0].day).toBe("Mon");
  });

  test("omits hourly/forecast when arrays are empty", () => {
    const result = parseWeatherData({
      location: "NYC",
      hourly: [],
      forecast: [],
    });
    expect(result!.hourly).toBeUndefined();
    expect(result!.forecast).toBeUndefined();
  });

  test("filters non-object items from hourly/forecast arrays", () => {
    const result = parseWeatherData({
      location: "NYC",
      hourly: [null, 42, "bad", { time: "Now", icon: "sun.max.fill" }],
      forecast: [null, { day: "Mon", icon: "cloud.fill" }],
    });
    expect(result!.hourly).toHaveLength(1);
    expect(result!.forecast).toHaveLength(1);
  });

  test("handles snake_case field names for feels_like and wind_speed", () => {
    const result = parseWeatherData({
      location: "NYC",
      feels_like: 65,
      wind_speed: 10,
      wind_direction: "SE",
    });
    expect(result!.feelsLike).toBe(65);
    expect(result!.windSpeed).toBe(10);
    expect(result!.windDirection).toBe("SE");
  });
});

// ---------------------------------------------------------------------------
// displayTemp
// ---------------------------------------------------------------------------

describe("displayTemp", () => {
  test("returns null for undefined", () => {
    expect(displayTemp(undefined, true, true)).toBeNull();
  });

  test("returns rounded string when source matches display", () => {
    expect(displayTemp(72.6, true, true)).toBe("73");
    expect(displayTemp(22.3, false, false)).toBe("22");
  });

  test("converts F → C", () => {
    // 32°F = 0°C
    expect(displayTemp(32, true, false)).toBe("0");
    // 212°F = 100°C
    expect(displayTemp(212, true, false)).toBe("100");
  });

  test("converts C → F", () => {
    // 0°C = 32°F
    expect(displayTemp(0, false, true)).toBe("32");
    // 100°C = 212°F
    expect(displayTemp(100, false, true)).toBe("212");
  });

  test("handles zero correctly", () => {
    expect(displayTemp(0, true, true)).toBe("0");
    expect(displayTemp(0, false, false)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// getHourlyTemp
// ---------------------------------------------------------------------------

describe("getHourlyTemp", () => {
  test("prefers tempC and treats it as Celsius", () => {
    const item = { time: "1PM", icon: "sun.max.fill", temp: 22, tempC: 22 };
    // Source is F, display is F → tempC (22°C) should convert to F
    expect(getHourlyTemp(item, true, true)).toBe("72");
  });

  test("falls back to temp with source unit", () => {
    const item = { time: "1PM", icon: "sun.max.fill", temp: 72 };
    expect(getHourlyTemp(item, true, true)).toBe("72");
    expect(getHourlyTemp(item, true, false)).toBe("22");
  });

  test("returns null when no temp fields present", () => {
    const item = { time: "1PM", icon: "sun.max.fill" };
    expect(getHourlyTemp(item, true, true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDayLow / getDayHigh
// ---------------------------------------------------------------------------

describe("getDayLow", () => {
  test("prefers lowC and treats it as Celsius", () => {
    const item = { icon: "cloud.fill", low: 55, lowC: 13 };
    expect(getDayLow(item, true, false)).toBe("13");
    expect(getDayLow(item, true, true)).toBe("55");
  });

  test("falls back to low with source unit", () => {
    const item = { icon: "cloud.fill", low: 55 };
    expect(getDayLow(item, true, true)).toBe("55");
  });

  test("returns null when no low fields", () => {
    expect(getDayLow({ icon: "cloud.fill" }, true, true)).toBeNull();
  });
});

describe("getDayHigh", () => {
  test("prefers highC and treats it as Celsius", () => {
    const item = { icon: "cloud.fill", high: 75, highC: 24 };
    expect(getDayHigh(item, true, false)).toBe("24");
    expect(getDayHigh(item, true, true)).toBe("75");
  });

  test("falls back to high with source unit", () => {
    const item = { icon: "cloud.fill", high: 75 };
    expect(getDayHigh(item, true, true)).toBe("75");
  });
});
