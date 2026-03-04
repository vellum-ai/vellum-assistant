// ---------------------------------------------------------------------------
// Inline types (subset of assistant ToolExecutionResult / ProxyToolResolver)
// ---------------------------------------------------------------------------

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export type ProxyToolResolver = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<ToolExecutionResult>;

const log = {
  debug: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
};

const GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface WeatherPageInput {
  location: string;
  currentTemp: number;
  feelsLike: number;
  unit: string;
  condition: string;
  conditionCode: number;
  humidity: number;
  windSpeed: number;
  windDirection: string;
  speedUnit: string;
  todayHigh: number;
  todayLow: number;
  hourly: Array<{ time: string; temp: number; tempAlt: number; code: number }>;
  forecast: Array<{
    day: string;
    low: number;
    high: number;
    lowAlt: number;
    highAlt: number;
    precip: number | null;
    code: number;
  }>;
  unitAlt: string;
  speedUnitAlt: string;
  currentTempAlt: number;
  feelsLikeAlt: number;
  todayHighAlt: number;
  todayLowAlt: number;
  windSpeedAlt: number;
}

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

/**
 * Maps WMO weather codes to SF Symbol icon names for native rendering.
 * When `isDay` is false, uses moon/night variants for clear and partly cloudy.
 */
export function weatherCodeToSFSymbol(
  code: number,
  isDay: boolean = true,
): string {
  if (code === 0) return isDay ? "sun.max.fill" : "moon.fill";
  if (code === 1) return isDay ? "sun.max.fill" : "moon.fill";
  if (code === 2) return isDay ? "cloud.sun.fill" : "cloud.moon.fill";
  if (code === 3) return "cloud.fill";
  if (code === 45 || code === 48) return "cloud.fog.fill";
  if (code >= 51 && code <= 57) return "cloud.rain.fill";
  if (code >= 61 && code <= 67) return "cloud.rain.fill";
  if (code >= 71 && code <= 77) return "snowflake";
  if (code >= 80 && code <= 82) return "cloud.rain.fill";
  if (code >= 85 && code <= 86) return "snowflake";
  if (code >= 95) return "cloud.bolt.fill";
  return "cloud.fill";
}

/**
 * Maps WMO weather codes to emoji for HTML rendering.
 */
function weatherCodeToEmoji(code: number): string {
  if (code === 0) return "\u2600\uFE0F";
  if (code === 1) return "\uD83C\uDF24\uFE0F";
  if (code === 2) return "\u26C5";
  if (code === 3) return "\u2601\uFE0F";
  if (code === 45 || code === 48) return "\uD83C\uDF2B\uFE0F";
  if (code >= 51 && code <= 57) return "\uD83C\uDF27\uFE0F";
  if (code >= 61 && code <= 67) return "\uD83C\uDF27\uFE0F";
  if (code >= 71 && code <= 77) return "\u2744\uFE0F";
  if (code >= 80 && code <= 82) return "\uD83C\uDF26\uFE0F";
  if (code >= 85 && code <= 86) return "\uD83C\uDF28\uFE0F";
  if (code >= 95) return "\u26C8\uFE0F";
  return "\u2601\uFE0F";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/**
 * Builds a self-contained HTML weather page using the Vellum design system tokens.
 * This renders in the workspace when the user clicks "View Output" on the preview card.
 * Includes a segmented F/C toggle that swaps all temperatures and wind speeds inline.
 */
function buildWeatherPageHtml(d: WeatherPageInput): string {
  const condEmoji = weatherCodeToEmoji(d.conditionCode);
  const isF = d.unit === "F";

  const tempF = isF ? d.currentTemp : d.currentTempAlt;
  const tempC = isF ? d.currentTempAlt : d.currentTemp;
  const feelsF = isF ? d.feelsLike : d.feelsLikeAlt;
  const feelsC = isF ? d.feelsLikeAlt : d.feelsLike;
  const highF = isF ? d.todayHigh : d.todayHighAlt;
  const highC = isF ? d.todayHighAlt : d.todayHigh;
  const lowF = isF ? d.todayLow : d.todayLowAlt;
  const lowC = isF ? d.todayLowAlt : d.todayLow;
  const windMph = isF ? d.windSpeed : d.windSpeedAlt;
  const windKph = isF ? d.windSpeedAlt : d.windSpeed;

  const hourlyHtml = d.hourly
    .slice(0, 24)
    .map((h) => {
      const e = weatherCodeToEmoji(h.code);
      const hf = isF ? h.temp : h.tempAlt;
      const hc = isF ? h.tempAlt : h.temp;
      return (
        `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;min-width:56px">` +
        `<div style="font-size:13px;color:var(--v-text-secondary)">${escapeHtml(
          h.time,
        )}</div>` +
        `<div style="font-size:20px">${e}</div>` +
        `<span data-temp-f="${hf}" data-temp-c="${hc}" style="font-size:14px;font-weight:500">${h.temp}\u00B0${d.unit}</span></div>`
      );
    })
    .join("");

  const dailyF = d.forecast.map((f) => ({
    low: isF ? f.low : f.lowAlt,
    high: isF ? f.high : f.highAlt,
  }));
  const dailyC = d.forecast.map((f) => ({
    low: isF ? f.lowAlt : f.low,
    high: isF ? f.highAlt : f.high,
  }));
  const allF = dailyF.flatMap((f) => [f.low, f.high]);
  const fMin = Math.min(...allF),
    fMax = Math.max(...allF),
    fRange = fMax - fMin || 1;
  const allC = dailyC.flatMap((f) => [f.low, f.high]);
  const cMin = Math.min(...allC),
    cMax = Math.max(...allC),
    cRange = cMax - cMin || 1;

  const dailyHtml = d.forecast
    .map((f, i) => {
      const e = weatherCodeToEmoji(f.code);
      const lf = dailyF[i].low,
        hf = dailyF[i].high;
      const lc = dailyC[i].low,
        hc = dailyC[i].high;
      const leftPctF = ((lf - fMin) / fRange) * 100;
      const widthPctF = Math.max(((hf - lf) / fRange) * 100, 3);
      const leftPctC = ((lc - cMin) / cRange) * 100;
      const widthPctC = Math.max(((hc - lc) / cRange) * 100, 3);
      const leftPct = isF ? leftPctF : leftPctC;
      const widthPct = isF ? widthPctF : widthPctC;
      const precipCell =
        f.precip != null && f.precip > 0
          ? `<span style="font-size:12px;color:var(--v-accent);width:36px;text-align:right">${f.precip}%</span>`
          : `<span style="width:36px"></span>`;
      return (
        `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--v-surface-border)">` +
        `<span style="width:44px;font-size:14px;font-weight:500">${escapeHtml(
          f.day,
        )}</span>` +
        `<span style="font-size:18px;width:28px;text-align:center">${e}</span>` +
        `${precipCell}` +
        `<span data-temp-f="${lf}" data-temp-c="${lc}" style="font-size:14px;color:var(--v-text-muted);width:36px;text-align:right">${f.low}\u00B0${d.unit}</span>` +
        `<div style="flex:1;height:6px;background:var(--v-surface);border-radius:3px;position:relative;overflow:hidden;min-width:80px">` +
        `<div data-bar data-left-f="${leftPctF}" data-width-f="${widthPctF}" data-left-c="${leftPctC}" data-width-c="${widthPctC}" style="position:absolute;left:${leftPct}%;width:${widthPct}%;height:100%;border-radius:3px;background:linear-gradient(to right,var(--v-emerald-400),var(--v-amber-400))"></div></div>` +
        `<span data-temp-f="${hf}" data-temp-c="${hc}" style="font-size:14px;font-weight:500;width:36px">${f.high}\u00B0${d.unit}</span></div>`
      );
    })
    .join("");

  const activeBg = "rgba(255,255,255,0.15)";
  const inactiveBg = "transparent";
  const activeColor = "var(--v-text)";
  const inactiveColor = "var(--v-text-muted)";
  const btnBase =
    "border:none;cursor:pointer;padding:5px 12px;font-size:13px;line-height:1;transition:background 0.15s,color 0.15s,font-weight 0.15s";

  return [
    `<div data-unit="${d.unit}" style="max-width:900px;margin:0 auto;padding:24px">`,
    `<div style="text-align:center;margin-bottom:24px">`,
    `<div style="font-size:13px;text-transform:uppercase;letter-spacing:2px;color:var(--v-text-secondary);font-weight:600;margin-bottom:16px">${escapeHtml(
      d.location,
    )}</div>`,
    `<div style="display:flex;align-items:center;justify-content:center;gap:16px">`,
    `<span data-temp-f="${tempF}" data-temp-c="${tempC}" style="font-size:72px;font-weight:200;line-height:1;color:var(--v-text)">${d.currentTemp}\u00B0${d.unit}</span>`,
    `<div style="text-align:left">`,
    `<div style="font-size:32px;line-height:1.2">${condEmoji}</div>`,
    `<div style="font-size:15px;color:var(--v-text);font-weight:500">${escapeHtml(
      d.condition,
    )}</div>`,
    `</div></div>`,
    `<div style="font-size:14px;color:var(--v-text-muted);margin-top:8px">Feels like <span data-temp-f="${feelsF}" data-temp-c="${feelsC}">${d.feelsLike}\u00B0${d.unit}</span> &middot; H:<span data-temp-f="${highF}" data-temp-c="${highC}">${d.todayHigh}\u00B0${d.unit}</span> L:<span data-temp-f="${lowF}" data-temp-c="${lowC}">${d.todayLow}\u00B0${d.unit}</span></div>`,
    `<div style="font-size:13px;color:var(--v-text-muted);margin-top:4px">\uD83D\uDCA8 <span data-wind-mph="${windMph}" data-wind-kph="${windKph}">${
      d.windSpeed
    } ${escapeHtml(d.speedUnit)}</span> ${escapeHtml(
      d.windDirection,
    )} &middot; \uD83D\uDCA7 ${d.humidity}%</div>`,
    `</div>`,
    `<div style="border-top:1px solid var(--v-surface-border);padding-top:16px;margin-bottom:16px">`,
    `<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--v-text-muted);margin-bottom:12px">Hourly Forecast</div>`,
    `<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:8px">${hourlyHtml}</div>`,
    `</div>`,
    `<div style="border-top:1px solid var(--v-surface-border);padding-top:16px">`,
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">`,
    `<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--v-text-muted)">${d.forecast.length}-Day Forecast</div>`,
    `<div style="display:inline-flex;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.12)">`,
    `<button data-unit-btn="F" style="${btnBase};border-radius:7px 0 0 7px;background:${
      isF ? activeBg : inactiveBg
    };color:${isF ? activeColor : inactiveColor};font-weight:${
      isF ? "600" : "400"
    }">\u00B0F</button>`,
    `<button data-unit-btn="C" style="${btnBase};border-radius:0 7px 7px 0;background:${
      isF ? inactiveBg : activeBg
    };color:${isF ? inactiveColor : activeColor};font-weight:${
      isF ? "400" : "600"
    }">\u00B0C</button>`,
    `</div></div>`,
    dailyHtml,
    `</div>`,
    `<script>(function(){`,
    `var r=document.querySelector('[data-unit]');if(!r)return;`,
    `r.addEventListener('click',function(e){`,
    `var b=e.target.closest('[data-unit-btn]');if(!b)return;`,
    `var u=b.getAttribute('data-unit-btn');`,
    `if(r.getAttribute('data-unit')===u)return;`,
    `r.setAttribute('data-unit',u);`,
    `var f=u==='F',s=f?'\\u00B0F':'\\u00B0C';`,
    `r.querySelectorAll('[data-temp-f]').forEach(function(el){`,
    `el.textContent=(f?el.getAttribute('data-temp-f'):el.getAttribute('data-temp-c'))+s;`,
    `});`,
    `r.querySelectorAll('[data-wind-mph]').forEach(function(el){`,
    `el.textContent=f?el.getAttribute('data-wind-mph')+' mph':el.getAttribute('data-wind-kph')+' km/h';`,
    `});`,
    `r.querySelectorAll('[data-bar]').forEach(function(el){`,
    `el.style.left=(f?el.getAttribute('data-left-f'):el.getAttribute('data-left-c'))+'%';`,
    `el.style.width=(f?el.getAttribute('data-width-f'):el.getAttribute('data-width-c'))+'%';`,
    `});`,
    `r.querySelectorAll('[data-unit-btn]').forEach(function(bt){`,
    `var on=bt.getAttribute('data-unit-btn')===u;`,
    `bt.style.background=on?'rgba(255,255,255,0.15)':'transparent';`,
    `bt.style.color=on?'var(--v-text)':'var(--v-text-muted)';`,
    `bt.style.fontWeight=on?'600':'400';`,
    `});`,
    `});`,
    `})()</script>`,
    `</div>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Main execution logic
// ---------------------------------------------------------------------------

export type FetchFn = typeof globalThis.fetch;

export async function executeGetWeather(
  input: Record<string, unknown>,
  fetchFn: FetchFn = globalThis.fetch,
  proxyToolResolver?: ProxyToolResolver,
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
    log.debug({ url: geoUrl }, "Geocoding location");

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
    log.error({ err, location }, "Geocoding request failed");
    return {
      content: `Error: Geocoding request failed: ${msg}`,
      isError: true,
    };
  }

  // Step 2: Fetch the weather forecast
  let forecast: ForecastResponse;
  try {
    const weatherUrl = `${FORECAST_API}?latitude=${geo.latitude}&longitude=${geo.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${forecastDays}`;
    log.debug({ url: weatherUrl }, "Fetching weather forecast");

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
    log.error({ err, location }, "Weather forecast request failed");
    return {
      content: `Error: Weather forecast request failed: ${msg}`,
      isError: true,
    };
  }

  // Step 3: Format the output
  const locationParts = [geo.name];
  if (geo.admin1) locationParts.push(geo.admin1);
  if (geo.country) locationParts.push(geo.country);
  const locationDisplay = locationParts.join(", ");

  const current = forecast.current;
  const tempUnit = useFahrenheit ? "F" : "C";
  const speedUnit = useFahrenheit ? "mph" : "km/h";

  const tempC = Math.round(current.temperature_2m);
  const tempF = celsiusToFahrenheit(current.temperature_2m);
  const currentTemp = useFahrenheit ? tempF : tempC;
  const currentTempAlt = useFahrenheit ? tempC : tempF;

  const feelsC = Math.round(current.apparent_temperature);
  const feelsF = celsiusToFahrenheit(current.apparent_temperature);
  const currentFeelsLike = useFahrenheit ? feelsF : feelsC;
  const currentFeelsLikeAlt = useFahrenheit ? feelsC : feelsF;

  const windKph = Math.round(current.wind_speed_10m);
  const windMph = kphToMph(current.wind_speed_10m);
  const currentWind = useFahrenheit ? windMph : windKph;
  const currentWindAlt = useFahrenheit ? windKph : windMph;
  const windDir = windDirectionToCompass(current.wind_direction_10m);
  const currentDescription = weatherCodeToDescription(current.weather_code);

  const lines: string[] = [
    `Weather for ${locationDisplay}`,
    `Coordinates: ${geo.latitude}, ${geo.longitude}`,
    "",
    "--- Current Conditions ---",
    `Temperature: ${currentTemp}\u00B0${tempUnit}`,
    `Feels like: ${currentFeelsLike}\u00B0${tempUnit}`,
    `Humidity: ${current.relative_humidity_2m}%`,
    `Wind: ${currentWind} ${speedUnit} ${windDir}`,
    `Conditions: ${currentDescription}`,
    "",
    `--- ${forecastDays}-Day Forecast ---`,
  ];

  const daily = forecast.daily;
  const forecastItems: Array<{
    day: string;
    icon: string;
    low: number;
    high: number;
    lowAlt: number;
    highAlt: number;
    precip: number | null;
    condition: string;
    code: number;
  }> = [];

  // The API returns dates in the location's local timezone (timezone=auto),
  // so the first entry is always "today" for that location.
  const todayStr = daily.time.length > 0 ? daily.time[0] : "";

  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i];
    const highC = Math.round(daily.temperature_2m_max[i]);
    const highF = celsiusToFahrenheit(daily.temperature_2m_max[i]);
    const high = useFahrenheit ? highF : highC;
    const highAlt = useFahrenheit ? highC : highF;
    const lowC = Math.round(daily.temperature_2m_min[i]);
    const lowF = celsiusToFahrenheit(daily.temperature_2m_min[i]);
    const low = useFahrenheit ? lowF : lowC;
    const lowAlt = useFahrenheit ? lowC : lowF;
    const precip = daily.precipitation_probability_max[i];
    const desc = weatherCodeToDescription(daily.weather_code[i]);
    const icon = weatherCodeToSFSymbol(daily.weather_code[i]);

    let dayLabel: string;
    if (date === todayStr) {
      dayLabel = "Today";
    } else {
      const d = new Date(date + "T12:00:00");
      dayLabel = d.toLocaleDateString("en-US", { weekday: "short" });
    }

    lines.push(
      `${date}: High ${high}\u00B0${tempUnit}, Low ${low}\u00B0${tempUnit}, Precip ${precip}%, ${desc}`,
    );

    forecastItems.push({
      day: dayLabel,
      icon,
      low,
      high,
      lowAlt,
      highAlt,
      precip: precip > 0 ? precip : null,
      condition: desc,
      code: daily.weather_code[i],
    });
  }

  // Process hourly data: next 24 hours from the current hour.
  // Use the current time from the API response (which is in the location's local
  // timezone, thanks to timezone=auto) to find the correct starting index.
  const hourlyItems: Array<{
    time: string;
    icon: string;
    temp: number;
    tempAlt: number;
    code: number;
  }> = [];
  if (forecast.hourly?.time) {
    const currentTimeLocal = forecast.current.time; // e.g. "2026-02-12T22:00"
    const currentHourPrefix = currentTimeLocal.slice(0, 13); // e.g. "2026-02-12T22"
    let startIndex = forecast.hourly.time.findIndex((t) =>
      t.startsWith(currentHourPrefix),
    );
    if (startIndex < 0) startIndex = 0;

    const count = Math.min(24, forecast.hourly.time.length - startIndex);
    for (let i = 0; i < count; i++) {
      const idx = startIndex + i;
      const hourTempC = Math.round(forecast.hourly.temperature_2m[idx]);
      const hourTempF = celsiusToFahrenheit(
        forecast.hourly.temperature_2m[idx],
      );
      const hourTemp = useFahrenheit ? hourTempF : hourTempC;
      const hourTempAlt = useFahrenheit ? hourTempC : hourTempF;
      const isDay = forecast.hourly.is_day[idx] === 1;
      const icon = weatherCodeToSFSymbol(
        forecast.hourly.weather_code[idx],
        isDay,
      );

      let timeLabel: string;
      if (i === 0) {
        timeLabel = "Now";
      } else {
        // Parse the hour directly from the time string (already in location-local
        // timezone) instead of relying on Date parsing which is runtime-dependent.
        const hour = parseInt(forecast.hourly.time[idx].slice(11, 13), 10);
        const suffix = hour >= 12 ? "PM" : "AM";
        const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        timeLabel = `${displayHour}${suffix}`;
      }

      hourlyItems.push({
        time: timeLabel,
        icon,
        temp: hourTemp,
        tempAlt: hourTempAlt,
        code: forecast.hourly.weather_code[idx],
      });
    }
  }

  // Build dynamic page HTML + preview for compact inline card with "View Output"
  const todayHigh =
    forecastItems.length > 0 ? forecastItems[0].high : currentTemp;
  const todayLow =
    forecastItems.length > 0 ? forecastItems[0].low : currentTemp;
  const todayHighAlt =
    forecastItems.length > 0 ? forecastItems[0].highAlt : currentTempAlt;
  const todayLowAlt =
    forecastItems.length > 0 ? forecastItems[0].lowAlt : currentTempAlt;

  const weatherHtml = buildWeatherPageHtml({
    location: locationDisplay,
    currentTemp,
    feelsLike: currentFeelsLike,
    unit: tempUnit,
    condition: currentDescription,
    conditionCode: current.weather_code,
    humidity: current.relative_humidity_2m,
    windSpeed: currentWind,
    windDirection: windDir,
    speedUnit,
    todayHigh,
    todayLow,
    hourly: hourlyItems.map((h) => ({
      time: h.time,
      temp: h.temp,
      tempAlt: h.tempAlt,
      code: h.code,
    })),
    forecast: forecastItems.map((f) => ({
      day: f.day,
      low: f.low,
      high: f.high,
      lowAlt: f.lowAlt,
      highAlt: f.highAlt,
      precip: f.precip,
      code: f.code,
    })),
    unitAlt: useFahrenheit ? "C" : "F",
    speedUnitAlt: useFahrenheit ? "km/h" : "mph",
    currentTempAlt,
    feelsLikeAlt: currentFeelsLikeAlt,
    todayHighAlt,
    todayLowAlt,
    windSpeedAlt: currentWindAlt,
  });

  const uiShowData = {
    html: weatherHtml,
    preview: {
      icon: weatherCodeToEmoji(current.weather_code),
      title: locationDisplay,
      subtitle: `${currentTemp}\u00B0${tempUnit} \u00B7 ${currentDescription}`,
      metrics: [
        { label: "Feels Like", value: `${currentFeelsLike}\u00B0${tempUnit}` },
        { label: "Wind", value: `${currentWind} ${speedUnit}` },
        { label: "Humidity", value: `${current.relative_humidity_2m}%` },
      ],
    },
  };

  // Auto-emit the weather surface via proxy resolver (same pattern as app_create).
  // This removes the need for the model to make a second ui_show call.
  if (proxyToolResolver) {
    try {
      await proxyToolResolver("ui_show", {
        surface_type: "dynamic_page",
        data: uiShowData,
      });
      // The trailing notice prevents the model from looping with web_search
      // to "verify" or "improve" data that is already live and complete.
      // Only added after a successful emit — if ui_show threw, the card
      // was NOT rendered and the model should remain free to retry.
      lines.push(
        "",
        "[Live data from Open-Meteo Weather API. The weather card is already rendered. Respond with a brief summary — do NOT call web_search, ui_show, or ui_update.]",
      );
    } catch (err) {
      log.warn({ err }, "Failed to auto-emit weather surface");
    }
    return { content: lines.join("\n"), isError: false };
  }

  // Fallback for non-UI channels: include render instructions for the model
  lines.push("", "--- Render with ui_show ---");
  lines.push(
    'Call ui_show with surface_type "dynamic_page" and the following data (pass exactly as-is):',
  );
  lines.push(JSON.stringify(uiShowData));

  return { content: lines.join("\n"), isError: false };
}
