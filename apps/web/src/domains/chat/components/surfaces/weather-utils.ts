/**
 * Pure utility functions for the weather forecast surface. No React dependency.
 *
 * Responsibilities:
 * - Icon mapping (SF Symbol / condition string → Lucide icon + color class)
 * - Defensive data parsing (raw daemon payload → typed `WeatherForecastData`)
 * - Temperature/unit conversion (F↔C, mph↔km/h, display formatting)
 *
 * The raw Tailwind colors in the icon maps (`text-orange-500`, `text-blue-400`,
 * etc.) are intentionally NOT semantic tokens — they represent real-world weather
 * phenomena and should remain fixed regardless of UI theme.
 */

import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSun,
  type LucideIcon,
  Moon,
  Snowflake,
  Sun,
  Wind,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherHourlyItem {
  id?: string;
  time: string;
  icon: string;
  temp?: number;
  temperature?: number;
  tempC?: number;
}

export interface WeatherForecastItem {
  id?: string;
  day?: string;
  dayLabel?: string;
  icon: string;
  low?: number;
  high?: number;
  lowC?: number;
  highC?: number;
  precip?: number;
  precipitationProbability?: number;
  condition?: string;
}

export interface WeatherForecastData {
  location: string | { name: string };
  currentTemp?: number;
  feelsLike?: number;
  condition?: string;
  humidity?: number;
  windSpeed?: number;
  windDirection?: string;
  unit?: string;
  hourly?: WeatherHourlyItem[];
  forecast?: WeatherForecastItem[];
}

// ---------------------------------------------------------------------------
// Icon mapping
// ---------------------------------------------------------------------------

export interface IconEntry {
  icon: LucideIcon;
  className: string;
}

const SF_SYMBOL_MAP: Record<string, IconEntry> = {
  "sun.max.fill": { icon: Sun, className: "text-orange-500" },
  "cloud.sun.fill": { icon: CloudSun, className: "text-amber-400" },
  "moon.fill": { icon: Moon, className: "text-blue-400" },
  "cloud.moon.fill": { icon: CloudMoon, className: "text-blue-400" },
  "cloud.fill": { icon: Cloud, className: "text-stone-400" },
  "cloud.rain.fill": { icon: CloudRain, className: "text-blue-400" },
  snowflake: { icon: Snowflake, className: "text-blue-300" },
  "cloud.bolt.fill": { icon: CloudLightning, className: "text-orange-500" },
  "cloud.fog.fill": { icon: CloudFog, className: "text-stone-400" },
};

const CONDITION_MAP: Record<string, IconEntry> = {
  sunny: { icon: Sun, className: "text-orange-500" },
  clear: { icon: Sun, className: "text-orange-500" },
  "partly cloudy": { icon: CloudSun, className: "text-amber-400" },
  "mostly sunny": { icon: CloudSun, className: "text-amber-400" },
  cloudy: { icon: Cloud, className: "text-stone-400" },
  overcast: { icon: Cloud, className: "text-stone-400" },
  rainy: { icon: CloudRain, className: "text-blue-400" },
  rain: { icon: CloudRain, className: "text-blue-400" },
  drizzle: { icon: CloudRain, className: "text-blue-400" },
  snow: { icon: Snowflake, className: "text-blue-300" },
  snowy: { icon: Snowflake, className: "text-blue-300" },
  thunderstorm: { icon: CloudLightning, className: "text-orange-500" },
  thunder: { icon: CloudLightning, className: "text-orange-500" },
  foggy: { icon: CloudFog, className: "text-stone-400" },
  fog: { icon: CloudFog, className: "text-stone-400" },
  mist: { icon: CloudFog, className: "text-stone-400" },
  hazy: { icon: CloudFog, className: "text-stone-400" },
  night: { icon: Moon, className: "text-blue-400" },
  "mainly clear": { icon: Sun, className: "text-orange-500" },
  "mostly cloudy": { icon: Cloud, className: "text-stone-400" },
  breezy: { icon: Wind, className: "text-stone-400" },
  windy: { icon: Wind, className: "text-stone-400" },
  cool: { icon: Cloud, className: "text-stone-400" },
  warm: { icon: Sun, className: "text-orange-500" },
  hot: { icon: Sun, className: "text-orange-500" },
  cold: { icon: Snowflake, className: "text-blue-300" },
  "cold snap": { icon: Snowflake, className: "text-blue-300" },
  "warm, mostly sunny": { icon: CloudSun, className: "text-amber-400" },
  "cooler, breezy": { icon: Wind, className: "text-stone-400" },
};

const DEFAULT_ICON: IconEntry = { icon: Cloud, className: "text-stone-400" };

export function getWeatherIcon(iconStr: string): IconEntry {
  const sfMatch = SF_SYMBOL_MAP[iconStr];
  if (sfMatch) return sfMatch;

  const lower = iconStr.toLowerCase();
  const conditionMatch = CONDITION_MAP[lower];
  if (conditionMatch) return conditionMatch;

  for (const [key, entry] of Object.entries(CONDITION_MAP)) {
    if (lower.includes(key)) return entry;
  }

  return DEFAULT_ICON;
}

// ---------------------------------------------------------------------------
// Data parsing
// ---------------------------------------------------------------------------

function num(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}

function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function rec(val: unknown): Record<string, unknown> | undefined {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function parseWind(val: unknown): { speed?: number; direction?: string } {
  if (typeof val === "string") {
    const match = val.match(/^(\d+)\s*mph\s*(.*)/i);
    if (match) return { speed: Number(match[1]), direction: match[2]?.trim() || undefined };
  }
  return {};
}

export function parseWeatherData(raw: Record<string, unknown>): WeatherForecastData | null {
  // Location (required)
  let location: string | { name: string } | undefined;
  if (typeof raw.location === "string") {
    location = raw.location;
  } else {
    const locObj = rec(raw.location);
    if (locObj && typeof locObj.name === "string") {
      location = { name: locObj.name };
    }
  }
  if (!location) return null;

  // Current temperature: check nested `current` first, then top-level
  const current = rec(raw.current);
  const currentTemp = num(current?.temp) ?? num(raw.currentTemp) ?? num(raw.temperature) ?? num(raw.temp);
  const feelsLike = num(current?.feelsLike) ?? num(current?.feels_like) ?? num(current?.apparentTemperature) ?? num(raw.feelsLike) ?? num(raw.feels_like) ?? num(raw.apparentTemperature);
  const condition = str(current?.condition) ?? str(raw.condition);
  const humidity = num(current?.humidity) ?? num(raw.humidity);
  const parsedWind = parseWind(current?.wind ?? raw.wind);
  const windSpeed = num(current?.windSpeed) ?? num(current?.wind_speed) ?? num(raw.windSpeed) ?? num(raw.wind_speed) ?? parsedWind.speed;
  const windDirection = str(current?.windDirection) ?? str(current?.wind_direction) ?? str(raw.windDirection) ?? str(raw.wind_direction) ?? parsedWind.direction;

  // Unit
  const units = rec(raw.units);
  const unit = str(units?.temperature) ?? str(current?.unit) ?? str(raw.unit) ?? "F";

  // Hourly
  const hourlyRaw = Array.isArray(raw.hourly) ? raw.hourly : [];
  const hourly: WeatherHourlyItem[] = hourlyRaw
    .filter((h): h is Record<string, unknown> => h !== null && typeof h === "object")
    .map((h, i) => ({
      id: str(h.id) ?? String(i),
      time: str(h.time) ?? "",
      icon: str(h.icon) ?? str(h.condition) ?? "cloud.fill",
      temp: num(h.temp),
      temperature: num(h.temperature),
      tempC: num(h.tempC),
    }));

  // Daily / forecast — accept forecast, daily, or days
  const dailyRaw = Array.isArray(raw.forecast) ? raw.forecast
    : Array.isArray(raw.daily) ? raw.daily
    : Array.isArray(raw.days) ? raw.days
    : [];
  const forecast: WeatherForecastItem[] = dailyRaw
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === "object")
    .map((d, i) => ({
      id: str(d.id) ?? String(i),
      day: str(d.day) ?? str(d.date),
      dayLabel: str(d.dayLabel) ?? str(d.date),
      icon: str(d.icon) ?? str(d.condition) ?? "cloud.fill",
      low: num(d.low),
      high: num(d.high),
      lowC: num(d.lowC),
      highC: num(d.highC),
      precip: num(d.precip) ?? num(d.precipitation) ?? num(d.precipitationProbability),
      precipitationProbability: num(d.precipitationProbability) ?? num(d.precipitation) ?? num(d.precip),
      condition: str(d.condition),
    }));

  return {
    location,
    currentTemp,
    feelsLike,
    condition,
    humidity,
    windSpeed,
    windDirection,
    unit,
    hourly: hourly.length > 0 ? hourly : undefined,
    forecast: forecast.length > 0 ? forecast : undefined,
  };
}

// ---------------------------------------------------------------------------
// Temperature conversion helpers
// ---------------------------------------------------------------------------

function toF(c: number): number {
  return c * 9 / 5 + 32;
}

function toC(f: number): number {
  return (f - 32) * 5 / 9;
}

export function displayTemp(
  value: number | undefined,
  sourceIsFahrenheit: boolean,
  useFahrenheit: boolean,
): string | null {
  if (value === undefined) return null;
  let result = value;
  if (sourceIsFahrenheit && !useFahrenheit) result = toC(value);
  if (!sourceIsFahrenheit && useFahrenheit) result = toF(value);
  return `${Math.round(result)}`;
}

export function mphToKmh(mph: number): number {
  return mph * 1.60934;
}

export function kmhToMph(kmh: number): number {
  return kmh / 1.60934;
}

export function getHourlyTemp(item: WeatherHourlyItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.tempC !== undefined) return displayTemp(item.tempC, false, useFahrenheit);
  const raw = item.temp ?? item.temperature;
  if (raw === undefined) return null;
  return displayTemp(raw, sourceIsFahrenheit, useFahrenheit);
}

export function getDayLow(item: WeatherForecastItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.lowC !== undefined) return displayTemp(item.lowC, false, useFahrenheit);
  return displayTemp(item.low, sourceIsFahrenheit, useFahrenheit);
}

export function getDayHigh(item: WeatherForecastItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.highC !== undefined) return displayTemp(item.highC, false, useFahrenheit);
  return displayTemp(item.high, sourceIsFahrenheit, useFahrenheit);
}

export function getPrecip(item: WeatherForecastItem): number | undefined {
  return item.precip ?? item.precipitationProbability;
}
