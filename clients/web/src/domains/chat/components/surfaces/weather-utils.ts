/**
 * Pure utility functions for the weather forecast surface.
 *
 * Responsibilities:
 * - Icon mapping (SF Symbol / condition string → Lucide icon + color class)
 * - Defensive data parsing (raw daemon payload → typed `WeatherForecastData`)
 * - Temperature/unit conversion (F↔C, display formatting)
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

import { filterRecords, num, rec, str } from "@/domains/chat/components/surfaces/surface-parse-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherHourlyItem {
  id?: string;
  time: string;
  icon: string;
  temp?: number;
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
  condition?: string;
}

export interface WeatherForecastData {
  location: string;
  currentTemp?: number;
  feelsLike?: number;
  condition?: string;
  humidity?: number;
  windSpeed?: number;
  windDirection?: string;
  windUnit?: string;
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

function parseWind(val: unknown): { speed?: number; direction?: string } {
  if (typeof val === "string") {
    const match = val.match(/^(\d+)\s*mph\s*(.*)/i);
    if (match) return { speed: Number(match[1]), direction: match[2]?.trim() || undefined };
  }
  return {};
}

export function parseWeatherData(raw: Record<string, unknown>): WeatherForecastData | null {
  // Location (required) — normalize to string during parsing
  let location: string | undefined;
  if (typeof raw.location === "string") {
    location = raw.location;
  } else {
    const locObj = rec(raw.location);
    if (locObj && typeof locObj.name === "string") {
      location = locObj.name;
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

  // Units
  const units = rec(raw.units);
  const unit = str(units?.temperature) ?? str(current?.unit) ?? str(raw.unit) ?? "F";
  const windUnit = str(units?.speed) ?? str(raw.windUnit) ?? str(raw.wind_unit);

  // Hourly
  const hourly: WeatherHourlyItem[] = filterRecords(raw.hourly)
    .map((h, i) => ({
      id: str(h.id) ?? String(i),
      time: str(h.time) ?? "",
      icon: str(h.icon) ?? str(h.condition) ?? "cloud.fill",
      temp: num(h.tempC) ?? num(h.temp) ?? num(h.temperature),
      tempC: num(h.tempC),
    }));

  // Daily / forecast — prefer forecast, fall back to daily/days. Use Array.isArray
  // so a malformed non-array forecast doesn't shadow a valid daily/days array.
  const dailyRaw = [raw.forecast, raw.daily, raw.days].find(Array.isArray);
  const forecast: WeatherForecastItem[] = filterRecords(dailyRaw)
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
    windUnit,
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

export function getHourlyTemp(item: WeatherHourlyItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.tempC !== undefined) return displayTemp(item.tempC, false, useFahrenheit);
  if (item.temp === undefined) return null;
  return displayTemp(item.temp, sourceIsFahrenheit, useFahrenheit);
}

export function getDayLow(item: WeatherForecastItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.lowC !== undefined) return displayTemp(item.lowC, false, useFahrenheit);
  return displayTemp(item.low, sourceIsFahrenheit, useFahrenheit);
}

export function getDayHigh(item: WeatherForecastItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.highC !== undefined) return displayTemp(item.highC, false, useFahrenheit);
  return displayTemp(item.high, sourceIsFahrenheit, useFahrenheit);
}
