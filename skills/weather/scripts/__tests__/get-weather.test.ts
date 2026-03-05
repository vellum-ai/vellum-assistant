import { describe, expect, test } from "bun:test";

import {
  executeGetWeather,
  weatherCodeToDescription,
} from "../service.js";

// ---------------------------------------------------------------------------
// Helper: build a mock fetch that returns predefined geocoding & weather data
// ---------------------------------------------------------------------------

function createMockFetch(options?: {
  geoResults?: unknown[];
  geoStatus?: number;
  geoError?: Error;
  forecastData?: unknown;
  forecastStatus?: number;
  forecastError?: Error;
}): typeof globalThis.fetch {
  const {
    geoResults,
    geoStatus = 200,
    geoError,
    forecastData,
    forecastStatus = 200,
    forecastError,
  } = options ?? {};

  const defaultGeoResults = [
    {
      name: "San Francisco",
      latitude: 37.7749,
      longitude: -122.4194,
      country: "United States",
      admin1: "California",
    },
  ];

  // Generate 48 hourly entries starting from 2025-01-15T00:00
  const hourlyTimes: string[] = [];
  const hourlyTemps: number[] = [];
  const hourlyCodes: number[] = [];
  const hourlyIsDay: number[] = [];
  for (let i = 0; i < 48; i++) {
    const h = i % 24;
    hourlyTimes.push(
      `2025-01-${15 + Math.floor(i / 24)}T${String(h).padStart(2, "0")}:00`,
    );
    hourlyTemps.push(10 + Math.sin(i / 4) * 5);
    hourlyCodes.push(i % 3 === 0 ? 0 : 2);
    hourlyIsDay.push(h >= 7 && h < 19 ? 1 : 0);
  }

  const defaultForecastData = {
    current: {
      time: "2025-01-15T08:00",
      temperature_2m: 15.0,
      relative_humidity_2m: 72,
      apparent_temperature: 13.5,
      weather_code: 2,
      wind_speed_10m: 18.0,
      wind_direction_10m: 270,
    },
    current_units: {
      temperature_2m: "\u00B0C",
      relative_humidity_2m: "%",
      apparent_temperature: "\u00B0C",
      wind_speed_10m: "km/h",
      wind_direction_10m: "\u00B0",
    },
    hourly: {
      time: hourlyTimes,
      temperature_2m: hourlyTemps,
      weather_code: hourlyCodes,
      is_day: hourlyIsDay,
    },
    hourly_units: {
      temperature_2m: "\u00B0C",
      weather_code: "wmo code",
      is_day: "",
    },
    daily: {
      time: [
        "2025-01-15",
        "2025-01-16",
        "2025-01-17",
        "2025-01-18",
        "2025-01-19",
      ],
      weather_code: [2, 61, 3, 0, 1],
      temperature_2m_max: [17.0, 14.0, 16.0, 19.0, 20.0],
      temperature_2m_min: [10.0, 8.0, 9.0, 11.0, 12.0],
      precipitation_probability_max: [10, 80, 30, 0, 5],
    },
    daily_units: {
      temperature_2m_max: "\u00B0C",
      temperature_2m_min: "\u00B0C",
      precipitation_probability_max: "%",
    },
  };

  return (async (url: string | URL | Request) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    if (urlStr.includes("geocoding-api.open-meteo.com")) {
      if (geoError) throw geoError;
      return new Response(
        JSON.stringify({ results: geoResults ?? defaultGeoResults }),
        {
          status: geoStatus,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (urlStr.includes("api.open-meteo.com")) {
      if (forecastError) throw forecastError;
      return new Response(JSON.stringify(forecastData ?? defaultForecastData), {
        status: forecastStatus,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Weather code mapping
// ---------------------------------------------------------------------------

describe("weatherCodeToDescription", () => {
  test("maps clear sky (code 0)", () => {
    expect(weatherCodeToDescription(0)).toBe("Clear sky");
  });

  test("maps partly cloudy (code 2)", () => {
    expect(weatherCodeToDescription(2)).toBe("Partly cloudy");
  });

  test("maps moderate rain (code 63)", () => {
    expect(weatherCodeToDescription(63)).toBe("Moderate rain");
  });

  test("maps heavy snowfall (code 75)", () => {
    expect(weatherCodeToDescription(75)).toBe("Heavy snowfall");
  });

  test("maps thunderstorm (code 95)", () => {
    expect(weatherCodeToDescription(95)).toBe("Thunderstorm");
  });

  test("maps thunderstorm with heavy hail (code 99)", () => {
    expect(weatherCodeToDescription(99)).toBe("Thunderstorm with heavy hail");
  });

  test("returns Unknown for unrecognized codes", () => {
    expect(weatherCodeToDescription(42)).toBe("Unknown");
    expect(weatherCodeToDescription(100)).toBe("Unknown");
    expect(weatherCodeToDescription(-1)).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// Geocoding parsing
// ---------------------------------------------------------------------------

describe("geocoding parsing", () => {
  test("extracts location name, admin1, and country from geocoding results", async () => {
    const mockFetch = createMockFetch();
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "San Francisco, California, United States",
    );
    expect(result.content).toContain("37.7749");
    expect(result.content).toContain("-122.4194");
  });

  test("handles location without admin1", async () => {
    const mockFetch = createMockFetch({
      geoResults: [
        {
          name: "Tokyo",
          latitude: 35.6762,
          longitude: 139.6503,
          country: "Japan",
        },
      ],
    });
    const result = await executeGetWeather({ location: "Tokyo" }, mockFetch);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Tokyo, Japan");
  });

  test("handles location without country", async () => {
    const mockFetch = createMockFetch({
      geoResults: [{ name: "Somewhere", latitude: 0, longitude: 0 }],
    });
    const result = await executeGetWeather(
      { location: "Somewhere" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Weather for Somewhere");
  });
});

// ---------------------------------------------------------------------------
// Weather output formatting
// ---------------------------------------------------------------------------

describe("weather output formatting", () => {
  test("returns current conditions in fahrenheit by default", async () => {
    const mockFetch = createMockFetch();
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    // 15C = 59F
    expect(result.content).toContain("59\u00B0F");
    expect(result.content).toContain("Humidity: 72%");
    expect(result.content).toContain("Partly cloudy");
  });

  test("returns current conditions in celsius when requested", async () => {
    const mockFetch = createMockFetch();
    const result = await executeGetWeather(
      { location: "San Francisco", units: "celsius" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("15\u00B0C");
    expect(result.content).toContain("Humidity: 72%");
  });

  test("includes 10-day forecast by default", async () => {
    const mockFetch = createMockFetch();
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("10-Day Forecast");
    expect(result.content).toContain("2025-01-15");
    expect(result.content).toContain("2025-01-19");
    expect(result.content).toContain("Precip");
  });

  test("wind speed is converted to mph in fahrenheit mode", async () => {
    const mockFetch = createMockFetch();
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    // 18 km/h ~= 11 mph
    expect(result.content).toContain("11 mph");
    expect(result.content).toContain("W");
  });

  test("wind speed stays in km/h in celsius mode", async () => {
    const mockFetch = createMockFetch();
    const result = await executeGetWeather(
      { location: "San Francisco", units: "celsius" },
      mockFetch,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("18 km/h");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("returns error for missing location", async () => {
    const result = await executeGetWeather({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("location is required");
  });

  test("returns error for empty location", async () => {
    const result = await executeGetWeather({ location: "" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("location is required");
  });

  test("returns error for whitespace-only location", async () => {
    const result = await executeGetWeather({ location: "   " });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("location is required");
  });

  test("returns error for invalid units", async () => {
    const result = await executeGetWeather({
      location: "NYC",
      units: "kelvin",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('units must be "celsius" or "fahrenheit"');
  });

  test("returns error when location is not found", async () => {
    const mockFetch = createMockFetch({ geoResults: [] });
    const result = await executeGetWeather(
      { location: "xyznonexistent" },
      mockFetch,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not find location");
  });

  test("returns error when geocoding returns no results array", async () => {
    // Return empty object with no results key
    const emptyGeoFetch = (async () => {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await executeGetWeather(
      { location: "unknown" },
      emptyGeoFetch,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Could not find location");
  });

  test("returns error when geocoding API returns non-200", async () => {
    const mockFetch = createMockFetch({ geoStatus: 500 });
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Geocoding API returned HTTP 500");
  });

  test("returns error when weather API returns non-200", async () => {
    const mockFetch = createMockFetch({ forecastStatus: 503 });
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Weather API returned HTTP 503");
  });

  test("returns error when geocoding fetch throws", async () => {
    const mockFetch = createMockFetch({ geoError: new Error("Network error") });
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Geocoding request failed");
    expect(result.content).toContain("Network error");
  });

  test("returns error when weather fetch throws", async () => {
    const mockFetch = createMockFetch({
      forecastError: new Error("Connection refused"),
    });
    const result = await executeGetWeather(
      { location: "San Francisco" },
      mockFetch,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Weather forecast request failed");
    expect(result.content).toContain("Connection refused");
  });
});
