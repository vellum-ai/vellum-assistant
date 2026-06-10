import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSun,
  Droplets,
  type LucideIcon,
  Moon,
  Snowflake,
  Sun,
  Wind,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeatherHourlyItem {
  id?: string;
  time: string;
  icon: string;
  temp?: number;
  temperature?: number;
  tempC?: number;
}

interface WeatherForecastItem {
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

interface WeatherForecastData {
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

interface IconEntry {
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

function getWeatherIcon(iconStr: string): IconEntry {
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

function WeatherIcon({ icon: iconStr, size = 20 }: { icon: string; size?: number }) {
  const { icon: Icon, className } = getWeatherIcon(iconStr);
  return <Icon width={size} height={size} className={className} />;
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

function parseWeatherData(raw: Record<string, unknown>): WeatherForecastData | null {
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

function displayTemp(
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

function mphToKmh(mph: number): number {
  return mph * 1.60934;
}

function kmhToMph(kmh: number): number {
  return kmh / 1.60934;
}

function getHourlyTemp(item: WeatherHourlyItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  // Prefer explicit Celsius field; otherwise fall back to temp/temperature in source unit
  if (item.tempC !== undefined) return displayTemp(item.tempC, false, useFahrenheit);
  const raw = item.temp ?? item.temperature;
  if (raw === undefined) return null;
  return displayTemp(raw, sourceIsFahrenheit, useFahrenheit);
}

function getDayLow(item: WeatherForecastItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.lowC !== undefined) return displayTemp(item.lowC, false, useFahrenheit);
  return displayTemp(item.low, sourceIsFahrenheit, useFahrenheit);
}

function getDayHigh(item: WeatherForecastItem, sourceIsFahrenheit: boolean, useFahrenheit: boolean): string | null {
  if (item.highC !== undefined) return displayTemp(item.highC, false, useFahrenheit);
  return displayTemp(item.high, sourceIsFahrenheit, useFahrenheit);
}

function getPrecip(item: WeatherForecastItem): number | undefined {
  return item.precip ?? item.precipitationProbability;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function UnitToggle({
  useFahrenheit,
  onToggle,
}: {
  useFahrenheit: boolean;
  onToggle: (f: boolean) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-[var(--border-element)]">
      <button
        type="button"
        onClick={() => onToggle(true)}
        className={`px-2 py-0.5 text-body-small-default transition-colors ${
          useFahrenheit
            ? "bg-[var(--primary-base)] text-[var(--content-inset)]"
            : "bg-transparent text-[var(--content-quiet)]"
        }`}
      >
        &deg;F
      </button>
      <button
        type="button"
        onClick={() => onToggle(false)}
        className={`px-2 py-0.5 text-body-small-default transition-colors ${
          !useFahrenheit
            ? "bg-[var(--primary-base)] text-[var(--content-inset)]"
            : "bg-transparent text-[var(--content-quiet)]"
        }`}
      >
        &deg;C
      </button>
    </div>
  );
}

function HeroSection({
  data,
  sourceIsFahrenheit,
  useFahrenheit,
  onToggle,
}: {
  data: WeatherForecastData;
  sourceIsFahrenheit: boolean;
  useFahrenheit: boolean;
  onToggle: (f: boolean) => void;
}) {
  const locationName = typeof data.location === "string" ? data.location : data.location.name;
  const currentTempStr = displayTemp(data.currentTemp, sourceIsFahrenheit, useFahrenheit);
  const feelsLikeStr = displayTemp(data.feelsLike, sourceIsFahrenheit, useFahrenheit);
  const unitSymbol = useFahrenheit ? "F" : "C";

  // Today's H/L from the first forecast item
  const today = data.forecast?.[0];
  const todayHighStr = today ? getDayHigh(today, sourceIsFahrenheit, useFahrenheit) : null;
  const todayLowStr = today ? getDayLow(today, sourceIsFahrenheit, useFahrenheit) : null;

  // Wind speed conversion
  let windStr: string | null = null;
  if (data.windSpeed !== undefined) {
    const windUnit = useFahrenheit ? "mph" : "km/h";
    let speed = data.windSpeed;
    if (sourceIsFahrenheit && !useFahrenheit) speed = mphToKmh(data.windSpeed);
    if (!sourceIsFahrenheit && useFahrenheit) speed = kmhToMph(data.windSpeed);
    windStr = `${Math.round(speed)} ${windUnit}`;
    if (data.windDirection) windStr = `${data.windDirection} ${windStr}`;
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-body-medium-default text-[var(--content-tertiary)]">
            {locationName}
          </div>
          {currentTempStr !== null && (
            // typography: off-scale -- large hero temperature display matching macOS weather widget
             
            <div className="mt-1 text-4xl font-light text-[var(--content-default)]">
              {currentTempStr}&deg;{unitSymbol}
            </div>
          )}
          {data.condition && (
            <div className="mt-0.5 text-body-small-default text-[var(--content-quiet)]">
              {data.condition}
            </div>
          )}
        </div>
        <UnitToggle useFahrenheit={useFahrenheit} onToggle={onToggle} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {feelsLikeStr !== null && (
          <span className="text-body-small-default text-[var(--content-quiet)]">
            Feels like {feelsLikeStr}&deg;
          </span>
        )}
        {todayHighStr !== null && todayLowStr !== null && (
          <span className="text-body-small-default text-[var(--content-quiet)]">
            H:{todayHighStr}&deg; L:{todayLowStr}&deg;
          </span>
        )}
        {windStr && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-label-medium-default text-[var(--content-tertiary)]">
            <Wind width={12} height={12} />
            {windStr}
          </span>
        )}
        {data.humidity !== undefined && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2 py-0.5 text-label-medium-default text-[var(--content-tertiary)]">
            <Droplets width={12} height={12} />
            {data.humidity}%
          </span>
        )}
      </div>
    </div>
  );
}

function HourlySection({
  hourly,
  sourceIsFahrenheit,
  useFahrenheit,
}: {
  hourly: WeatherHourlyItem[];
  sourceIsFahrenheit: boolean;
  useFahrenheit: boolean;
}) {
  return (
    <div className="mt-3 border-t border-[var(--border-element)] pt-3">
      <div className="flex gap-3 overflow-x-auto">
        {hourly.map((item, i) => {
          const isNow = item.time.toLowerCase() === "now";
          const tempStr = getHourlyTemp(item, sourceIsFahrenheit, useFahrenheit);
          return (
            <div
              key={item.id ?? i}
              className="flex min-w-[3rem] shrink-0 flex-col items-center gap-1"
            >
              <span
                className={
                  isNow
                    ? "text-body-small-emphasised text-[var(--content-default)]"
                    : "text-label-medium-default text-[var(--content-quiet)]"
                }
              >
                {isNow ? "Now" : item.time}
              </span>
              <WeatherIcon icon={item.icon} size={18} />
              {tempStr !== null && (
                <span className="text-body-small-default text-[var(--content-default)]">
                  {tempStr}&deg;
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DailySection({
  forecast,
  currentTemp,
  sourceIsFahrenheit,
  useFahrenheit,
}: {
  forecast: WeatherForecastItem[];
  currentTemp?: number;
  sourceIsFahrenheit: boolean;
  useFahrenheit: boolean;
}) {
  // Compute the global min/max across all days for normalizing bars
  const { globalMin, globalMax } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const item of forecast) {
      const low = item.lowC ?? item.low;
      const high = item.highC ?? item.high;
      if (low !== undefined && low < min) min = low;
      if (high !== undefined && high > max) max = high;
    }
    return { globalMin: min === Infinity ? 0 : min, globalMax: max === -Infinity ? 100 : max };
  }, [forecast]);

  const range = globalMax - globalMin || 1;

  return (
    <div className="mt-3 border-t border-[var(--border-element)] pt-3">
      <div className="flex flex-col gap-2">
        {forecast.map((item, i) => {
          const dayName = item.dayLabel ?? item.day ?? `Day ${i + 1}`;
          const isToday = dayName.toLowerCase() === "today";
          const lowStr = getDayLow(item, sourceIsFahrenheit, useFahrenheit);
          const highStr = getDayHigh(item, sourceIsFahrenheit, useFahrenheit);
          const precip = getPrecip(item);

          // Bar positioning: normalize low/high within [globalMin, globalMax]
          const rawLow = item.lowC ?? item.low ?? globalMin;
          const rawHigh = item.highC ?? item.high ?? globalMax;
          const barLeft = ((rawLow - globalMin) / range) * 100;
          const barRight = ((rawHigh - globalMin) / range) * 100;
          const barWidth = Math.max(barRight - barLeft, 2);

          // Current temp dot position (only on today's row).
          // Normalize currentTemp to the same unit system as rawLow/rawHigh
          // (which prefer lowC/highC when available).
          let dotPosition: number | null = null;
          if (isToday && currentTemp !== undefined) {
            const barUsesCelsius = item.lowC !== undefined || item.highC !== undefined;
            const normalizedTemp = barUsesCelsius && sourceIsFahrenheit
              ? (currentTemp - 32) * 5 / 9
              : currentTemp;
            const clamped = Math.max(rawLow, Math.min(rawHigh, normalizedTemp));
            const dotPct = rawHigh !== rawLow ? ((clamped - rawLow) / (rawHigh - rawLow)) * 100 : 50;
            dotPosition = dotPct;
          }

          return (
            <div key={item.id ?? i} className="flex items-center gap-2">
              <span
                className={`w-12 shrink-0 truncate text-body-small-default ${
                  isToday
                    ? "text-[var(--content-default)]"
                    : "text-[var(--content-quiet)]"
                }`}
              >
                {dayName}
              </span>

              <div className="flex w-10 shrink-0 items-center justify-center gap-0.5">
                <WeatherIcon icon={item.icon} size={16} />
                {precip !== undefined && precip > 0 && (
                  <span className="text-label-small-default text-blue-400">
                    {Math.round(precip)}%
                  </span>
                )}
              </div>

              <span className="w-7 shrink-0 text-right text-body-small-default text-[var(--content-faint)]">
                {lowStr !== null ? `${lowStr}°` : "--"}
              </span>

              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
                <div
                  className="absolute top-0 h-full rounded-full bg-[var(--primary-base)]"
                  style={{
                    left: `${barLeft}%`,
                    width: `${barWidth}%`,
                  }}
                />
                {dotPosition !== null && (
                  <div
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--aux-white)] bg-[var(--aux-white)] shadow-sm"
                    style={{
                      left: `${barLeft + (dotPosition / 100) * barWidth}%`,
                    }}
                  />
                )}
              </div>

              <span className="w-7 shrink-0 text-right text-body-small-default text-[var(--content-default)]">
                {highStr !== null ? `${highStr}°` : "--"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function WeatherForecastDisplay({
  templateData,
  fallback,
}: {
  templateData: Record<string, unknown>;
  fallback?: ReactNode;
}) {
  const data = useMemo(() => parseWeatherData(templateData), [templateData]);

  const sourceIsFahrenheit = data?.unit?.toUpperCase() === "F" || data?.unit?.toLowerCase() === "fahrenheit";
  const [userUnit, setUserUnit] = useState<boolean | null>(null);
  const useFahrenheit = userUnit ?? sourceIsFahrenheit;

  const handleToggle = useCallback((value: boolean) => {
    setUserUnit(value);
  }, []);

  if (!data || (data.currentTemp === undefined && !data.forecast?.length)) return fallback ?? null;

  return (
    <div className="mt-3">
      <HeroSection
        data={data}
        sourceIsFahrenheit={sourceIsFahrenheit}
        useFahrenheit={useFahrenheit}
        onToggle={handleToggle}
      />

      {data.hourly && data.hourly.length > 0 && (
        <HourlySection
          hourly={data.hourly}
          sourceIsFahrenheit={sourceIsFahrenheit}
          useFahrenheit={useFahrenheit}
        />
      )}

      {data.forecast && data.forecast.length > 0 && (
        <DailySection
          forecast={data.forecast}
          currentTemp={data.currentTemp}
          sourceIsFahrenheit={sourceIsFahrenheit}
          useFahrenheit={useFahrenheit}
        />
      )}
    </div>
  );
}
