import { Droplets, Wind } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import type {
  WeatherForecastData,
  WeatherForecastItem,
  WeatherHourlyItem,
} from "@/domains/chat/components/surfaces/weather-utils";
import {
  displayTemp,
  getDayHigh,
  getDayLow,
  getHourlyTemp,
  getWeatherIcon,
  parseWeatherData,
} from "@/domains/chat/components/surfaces/weather-utils";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function WeatherIcon({ icon: iconStr, size = 20 }: { icon: string; size?: number }) {
  const { icon: Icon, className } = getWeatherIcon(iconStr);
  return <Icon width={size} height={size} className={className} />;
}

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
  const locationName = data.location;
  const currentTempStr = displayTemp(data.currentTemp, sourceIsFahrenheit, useFahrenheit);
  const feelsLikeStr = displayTemp(data.feelsLike, sourceIsFahrenheit, useFahrenheit);
  const unitSymbol = useFahrenheit ? "F" : "C";

  // Today's H/L from the first forecast item
  const today = data.forecast?.[0];
  const todayHighStr = today ? getDayHigh(today, sourceIsFahrenheit, useFahrenheit) : null;
  const todayLowStr = today ? getDayLow(today, sourceIsFahrenheit, useFahrenheit) : null;

  // Wind: display raw value with unit from payload (defaults to mph)
  let windStr: string | null = null;
  if (data.windSpeed !== undefined) {
    windStr = `${Math.round(data.windSpeed)} ${data.windUnit ?? "mph"}`;
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
          const precip = item.precip;

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

  if (!data || (data.currentTemp === undefined && !data.forecast?.length)) return fallback ?? null;

  return (
    <div className="mt-3">
      <HeroSection
        data={data}
        sourceIsFahrenheit={sourceIsFahrenheit}
        useFahrenheit={useFahrenheit}
        onToggle={setUserUnit}
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
