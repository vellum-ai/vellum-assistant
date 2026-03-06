// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

export interface CurrentWeather {
  time: string;
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  weather_code: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
}

export interface HourlyForecast {
  time: string[];
  temperature_2m: number[];
  weather_code: number[];
  is_day: number[];
}

export interface DailyForecast {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_probability_max: number[];
}

export interface ForecastResponse {
  current: CurrentWeather;
  current_units: Record<string, string>;
  hourly: HourlyForecast;
  hourly_units: Record<string, string>;
  daily: DailyForecast;
  daily_units: Record<string, string>;
}

// Structured output types for JSON mode
export interface WeatherData {
  location: {
    name: string;
    latitude: number;
    longitude: number;
  };
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    windDirection: string;
    condition: string;
    conditionCode: number;
  };
  hourly: Array<{
    time: string;
    temperature: number;
    condition: string;
    conditionCode: number;
    isDay: boolean;
  }>;
  daily: Array<{
    date: string;
    dayLabel: string;
    high: number;
    low: number;
    precipitationProbability: number;
    condition: string;
    conditionCode: number;
  }>;
  units: {
    temperature: "F" | "C";
    speed: "mph" | "km/h";
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Maps WMO weather codes (0-99) to human-readable descriptions.
 * See: https://www.noaa.gov/weather/codes
 */
export function weatherCodeToDescription(code: number): string {
  if (code === 0) return "Clear sky";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45) return "Foggy";
  if (code === 48) return "Depositing rime fog";
  if (code === 51) return "Light drizzle";
  if (code === 53) return "Moderate drizzle";
  if (code === 55) return "Dense drizzle";
  if (code === 56) return "Light freezing drizzle";
  if (code === 57) return "Dense freezing drizzle";
  if (code === 61) return "Slight rain";
  if (code === 63) return "Moderate rain";
  if (code === 65) return "Heavy rain";
  if (code === 66) return "Light freezing rain";
  if (code === 67) return "Heavy freezing rain";
  if (code === 71) return "Slight snowfall";
  if (code === 73) return "Moderate snowfall";
  if (code === 75) return "Heavy snowfall";
  if (code === 77) return "Snow grains";
  if (code === 80) return "Slight rain showers";
  if (code === 81) return "Moderate rain showers";
  if (code === 82) return "Violent rain showers";
  if (code === 85) return "Slight snow showers";
  if (code === 86) return "Heavy snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96) return "Thunderstorm with slight hail";
  if (code === 99) return "Thunderstorm with heavy hail";
  return "Unknown";
}

function windDirectionToCompass(degrees: number): string {
  const directions = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const index = Math.round(degrees / 22.5) % 16;
  return directions[index];
}

function celsiusToFahrenheit(celsius: number): number {
  return Math.round((celsius * 9) / 5 + 32);
}

function kphToMph(kph: number): number {
  return Math.round(kph * 0.621371);
}

// ---------------------------------------------------------------------------
// Main execution logic
// ---------------------------------------------------------------------------

export type FetchFn = typeof globalThis.fetch;

export async function executeGetWeather(
  input: Record<string, unknown>,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<ToolExecutionResult> {
  const location = input.location;
  if (typeof location !== "string" || location.trim() === "") {
    return {
      content: "Error: location is required and must be a non-empty string",
      isError: true,
    };
  }

  const units = (input.units as string) ?? "fahrenheit";
  if (units !== "celsius" && units !== "fahrenheit") {
    return {
      content: 'Error: units must be "celsius" or "fahrenheit"',
      isError: true,
    };
  }

  const useFahrenheit = units === "fahrenheit";

  // Forecast days: default 10, clamp to 1-16 (Open-Meteo max)
  const rawDays = typeof input.days === "number" ? input.days : 10;
  const forecastDays = Math.max(1, Math.min(16, Math.round(rawDays)));

  // Step 1: Geocode the location
  let geo: GeocodingResult;
  try {
    const geoUrl = `${GEOCODING_API}?name=${encodeURIComponent(
      location.trim(),
    )}&count=1`;

    const geoResponse = await fetchFn(geoUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!geoResponse.ok) {
      return {
        content: `Error: Geocoding API returned HTTP ${geoResponse.status}`,
        isError: true,
      };
    }

    const geoData = (await geoResponse.json()) as {
      results?: GeocodingResult[];
    };
    if (!geoData.results || geoData.results.length === 0) {
      return {
        content: `Error: Could not find location "${location}". Please try a different search term.`,
        isError: true,
      };
    }

    geo = geoData.results[0];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: Geocoding request failed: ${msg}`,
      isError: true,
    };
  }

  // Step 2: Fetch the weather forecast
  let forecast: ForecastResponse;
  try {
    const weatherUrl = `${FORECAST_API}?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${forecastDays}`;

    const weatherResponse = await fetchFn(weatherUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!weatherResponse.ok) {
      return {
        content: `Error: Weather API returned HTTP ${weatherResponse.status}`,
        isError: true,
      };
    }

    forecast = (await weatherResponse.json()) as ForecastResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Error: Weather forecast request failed: ${msg}`,
      isError: true,
    };
  }

  // Step 3: Build structured output
  const locationParts = [geo.name];
  if (geo.admin1) locationParts.push(geo.admin1);
  if (geo.country) locationParts.push(geo.country);
  const locationDisplay = locationParts.join(", ");

  const current = forecast.current;
  const tempUnit = useFahrenheit ? "F" : "C";
  const speedUnit = useFahrenheit ? "mph" : "km/h";

  const currentTemp = useFahrenheit
    ? celsiusToFahrenheit(current.temperature_2m)
    : Math.round(current.temperature_2m);
  const currentFeelsLike = useFahrenheit
    ? celsiusToFahrenheit(current.apparent_temperature)
    : Math.round(current.apparent_temperature);
  const currentWind = useFahrenheit
    ? kphToMph(current.wind_speed_10m)
    : Math.round(current.wind_speed_10m);
  const windDir = windDirectionToCompass(current.wind_direction_10m);
  const currentDescription = weatherCodeToDescription(current.weather_code);

  // Process daily forecast
  const daily = forecast.daily;
  const todayStr = daily.time.length > 0 ? daily.time[0] : "";

  const dailyItems = daily.time.map((date, i) => {
    const high = useFahrenheit
      ? celsiusToFahrenheit(daily.temperature_2m_max[i])
      : Math.round(daily.temperature_2m_max[i]);
    const low = useFahrenheit
      ? celsiusToFahrenheit(daily.temperature_2m_min[i])
      : Math.round(daily.temperature_2m_min[i]);

    let dayLabel: string;
    if (date === todayStr) {
      dayLabel = "Today";
    } else {
      const d = new Date(date + "T12:00:00");
      dayLabel = d.toLocaleDateString("en-US", { weekday: "short" });
    }

    return {
      date,
      dayLabel,
      high,
      low,
      precipitationProbability: daily.precipitation_probability_max[i],
      condition: weatherCodeToDescription(daily.weather_code[i]),
      conditionCode: daily.weather_code[i],
    };
  });

  // Process hourly data: next 24 hours from the current hour
  const hourlyItems: WeatherData["hourly"] = [];
  if (forecast.hourly?.time) {
    const currentTimeLocal = forecast.current.time;
    const currentHourPrefix = currentTimeLocal.slice(0, 13);
    let startIndex = forecast.hourly.time.findIndex((t) =>
      t.startsWith(currentHourPrefix),
    );
    if (startIndex < 0) startIndex = 0;

    const count = Math.min(24, forecast.hourly.time.length - startIndex);
    for (let i = 0; i < count; i++) {
      const idx = startIndex + i;
      const hourTemp = useFahrenheit
        ? celsiusToFahrenheit(forecast.hourly.temperature_2m[idx])
        : Math.round(forecast.hourly.temperature_2m[idx]);
      const isDay = forecast.hourly.is_day[idx] === 1;

      let timeLabel: string;
      if (i === 0) {
        timeLabel = "Now";
      } else {
        const hour = parseInt(forecast.hourly.time[idx].slice(11, 13), 10);
        const suffix = hour >= 12 ? "PM" : "AM";
        const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        timeLabel = `${displayHour}${suffix}`;
      }

      hourlyItems.push({
        time: timeLabel,
        temperature: hourTemp,
        condition: weatherCodeToDescription(forecast.hourly.weather_code[idx]),
        conditionCode: forecast.hourly.weather_code[idx],
        isDay,
      });
    }
  }

  // Build the structured weather data
  const weatherData: WeatherData = {
    location: {
      name: locationDisplay,
      latitude: geo.latitude,
      longitude: geo.longitude,
    },
    current: {
      temperature: currentTemp,
      feelsLike: currentFeelsLike,
      humidity: current.relative_humidity_2m,
      windSpeed: currentWind,
      windDirection: windDir,
      condition: currentDescription,
      conditionCode: current.weather_code,
    },
    hourly: hourlyItems,
    daily: dailyItems,
    units: {
      temperature: tempUnit as "F" | "C",
      speed: speedUnit as "mph" | "km/h",
    },
  };

  // Also build a human-readable text summary for convenience
  const lines: string[] = [
    `Weather for ${locationDisplay}`,
    `Coordinates: ${geo.latitude}, ${geo.longitude}`,
    "",
    "--- Current Conditions ---",
    `Temperature: ${currentTemp}°${tempUnit}`,
    `Feels like: ${currentFeelsLike}°${tempUnit}`,
    `Humidity: ${current.relative_humidity_2m}%`,
    `Wind: ${currentWind} ${speedUnit} ${windDir}`,
    `Conditions: ${currentDescription}`,
    "",
    `--- ${forecastDays}-Day Forecast ---`,
  ];

  for (const day of dailyItems) {
    lines.push(
      `${day.date}: High ${day.high}°${tempUnit}, Low ${day.low}°${tempUnit}, Precip ${day.precipitationProbability}%, ${day.condition}`,
    );
  }

  return {
    content: JSON.stringify({ text: lines.join("\n"), data: weatherData }),
    isError: false,
  };
}
