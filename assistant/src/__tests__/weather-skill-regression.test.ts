import { describe, test, expect, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { weatherCodeToDescription, weatherCodeToSFSymbol } from '../tools/weather/service.js';
import { getTool, __resetRegistryForTesting } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Regression tests: ensure the skill-loaded path produces the same results
// as the legacy hardcoded path after the weather tool migration.
// ---------------------------------------------------------------------------

// Clean up after this file to prevent contamination of later test files.
afterAll(() => { __resetRegistryForTesting(); });

const CONFIG_DIR = join(dirname(import.meta.dirname!), 'config', 'bundled-skills', 'weather');

describe('weather skill script wrapper', () => {
  test('exports a run function without registering get_weather in the tool registry', async () => {
    // Before importing the wrapper, verify get_weather is not in the registry.
    expect(getTool('get_weather')).toBeUndefined();

    // Dynamic import of the skill wrapper — it should NOT trigger any
    // registerTool side-effect (the wrapper delegates to the service module).
    const mod = await import('../config/bundled-skills/weather/tools/get-weather.js');
    expect(typeof mod.run).toBe('function');

    // After importing, the registry should still be clean — no side-effect.
    expect(getTool('get_weather')).toBeUndefined();
  });

  test('run function delegates to executeGetWeather from the service module', async () => {
    const mod = await import('../config/bundled-skills/weather/tools/get-weather.js');

    // Provide a minimal mock fetch and minimal input to verify delegation.
    const mockFetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;

      if (urlStr.includes('geocoding-api.open-meteo.com')) {
        return new Response(JSON.stringify({
          results: [{ name: 'TestCity', latitude: 0, longitude: 0, country: 'Testland' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      if (urlStr.includes('api.open-meteo.com')) {
        return new Response(JSON.stringify({
          current: {
            time: '2025-01-15T08:00',
            temperature_2m: 20,
            relative_humidity_2m: 50,
            apparent_temperature: 19,
            weather_code: 0,
            wind_speed_10m: 10,
            wind_direction_10m: 180,
          },
          current_units: {
            temperature_2m: '°C',
            relative_humidity_2m: '%',
            apparent_temperature: '°C',
            wind_speed_10m: 'km/h',
            wind_direction_10m: '°',
          },
          hourly: { time: [], temperature_2m: [], weather_code: [], is_day: [] },
          hourly_units: { temperature_2m: '°C', weather_code: 'wmo code', is_day: '' },
          daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [] },
          daily_units: { temperature_2m_max: '°C', temperature_2m_min: '°C', precipitation_probability_max: '%' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response('Not found', { status: 404 });
    }) as typeof globalThis.fetch;

    // Temporarily replace globalThis.fetch so the wrapper picks it up
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
      const result = await mod.run(
        { location: 'TestCity' },
        { proxyToolResolver: undefined } as unknown as ToolContext,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain('TestCity');
      expect(result.content).toContain('Clear sky');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('weather TOOLS.json manifest', () => {
  const manifest = JSON.parse(readFileSync(join(CONFIG_DIR, 'TOOLS.json'), 'utf-8'));

  test('has version 1', () => {
    expect(manifest.version).toBe(1);
  });

  test('declares exactly one tool', () => {
    expect(manifest.tools).toHaveLength(1);
  });

  test('tool is named get_weather', () => {
    expect(manifest.tools[0].name).toBe('get_weather');
  });

  test('tool has correct description', () => {
    expect(manifest.tools[0].description).toBe(
      'Get current weather conditions and forecast for a location',
    );
  });

  test('tool executor points to the skill script wrapper', () => {
    expect(manifest.tools[0].executor).toBe('tools/get-weather.ts');
  });

  test('tool execution_target is host', () => {
    expect(manifest.tools[0].execution_target).toBe('host');
  });

  test('input schema matches the legacy tool definition', () => {
    const schema = manifest.tools[0].input_schema;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['location']);

    // location property
    expect(schema.properties.location).toBeDefined();
    expect(schema.properties.location.type).toBe('string');

    // units property
    expect(schema.properties.units).toBeDefined();
    expect(schema.properties.units.type).toBe('string');
    expect(schema.properties.units.enum).toEqual(['celsius', 'fahrenheit']);

    // days property
    expect(schema.properties.days).toBeDefined();
    expect(schema.properties.days.type).toBe('number');
  });

});

describe('weather service module isolation', () => {
  test('executeGetWeather is importable without registerTool side effects', async () => {
    // Importing the service module should NOT call registerTool — only the
    // legacy get-weather.ts module does that.
    const mod = await import('../tools/weather/service.js');
    expect(typeof mod.executeGetWeather).toBe('function');
    expect(typeof mod.weatherCodeToDescription).toBe('function');
    expect(typeof mod.weatherCodeToSFSymbol).toBe('function');
  });

  test('weatherCodeToDescription returns correct values for all major code families', () => {
    // Clear/cloudy family
    expect(weatherCodeToDescription(0)).toBe('Clear sky');
    expect(weatherCodeToDescription(1)).toBe('Mainly clear');
    expect(weatherCodeToDescription(2)).toBe('Partly cloudy');
    expect(weatherCodeToDescription(3)).toBe('Overcast');

    // Fog family
    expect(weatherCodeToDescription(45)).toBe('Foggy');
    expect(weatherCodeToDescription(48)).toBe('Depositing rime fog');

    // Drizzle family
    expect(weatherCodeToDescription(51)).toBe('Light drizzle');
    expect(weatherCodeToDescription(53)).toBe('Moderate drizzle');
    expect(weatherCodeToDescription(55)).toBe('Dense drizzle');

    // Freezing drizzle
    expect(weatherCodeToDescription(56)).toBe('Light freezing drizzle');
    expect(weatherCodeToDescription(57)).toBe('Dense freezing drizzle');

    // Rain family
    expect(weatherCodeToDescription(61)).toBe('Slight rain');
    expect(weatherCodeToDescription(63)).toBe('Moderate rain');
    expect(weatherCodeToDescription(65)).toBe('Heavy rain');

    // Freezing rain
    expect(weatherCodeToDescription(66)).toBe('Light freezing rain');
    expect(weatherCodeToDescription(67)).toBe('Heavy freezing rain');

    // Snow family
    expect(weatherCodeToDescription(71)).toBe('Slight snowfall');
    expect(weatherCodeToDescription(73)).toBe('Moderate snowfall');
    expect(weatherCodeToDescription(75)).toBe('Heavy snowfall');
    expect(weatherCodeToDescription(77)).toBe('Snow grains');

    // Shower family
    expect(weatherCodeToDescription(80)).toBe('Slight rain showers');
    expect(weatherCodeToDescription(81)).toBe('Moderate rain showers');
    expect(weatherCodeToDescription(82)).toBe('Violent rain showers');
    expect(weatherCodeToDescription(85)).toBe('Slight snow showers');
    expect(weatherCodeToDescription(86)).toBe('Heavy snow showers');

    // Thunderstorm family
    expect(weatherCodeToDescription(95)).toBe('Thunderstorm');
    expect(weatherCodeToDescription(96)).toBe('Thunderstorm with slight hail');
    expect(weatherCodeToDescription(99)).toBe('Thunderstorm with heavy hail');

    // Unknown codes
    expect(weatherCodeToDescription(-1)).toBe('Unknown');
    expect(weatherCodeToDescription(42)).toBe('Unknown');
    expect(weatherCodeToDescription(100)).toBe('Unknown');
  });

  test('weatherCodeToSFSymbol returns correct icons and respects isDay', () => {
    // Day/night variants for clear sky
    expect(weatherCodeToSFSymbol(0, true)).toBe('sun.max.fill');
    expect(weatherCodeToSFSymbol(0, false)).toBe('moon.fill');

    // Day/night variants for partly cloudy
    expect(weatherCodeToSFSymbol(2, true)).toBe('cloud.sun.fill');
    expect(weatherCodeToSFSymbol(2, false)).toBe('cloud.moon.fill');

    // Overcast has no day/night variant
    expect(weatherCodeToSFSymbol(3, true)).toBe('cloud.fill');
    expect(weatherCodeToSFSymbol(3, false)).toBe('cloud.fill');

    // Snow
    expect(weatherCodeToSFSymbol(75, true)).toBe('snowflake');

    // Thunderstorm
    expect(weatherCodeToSFSymbol(95, true)).toBe('cloud.bolt.fill');

    // Default isDay=true when omitted
    expect(weatherCodeToSFSymbol(0)).toBe('sun.max.fill');
  });
});
