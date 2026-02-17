import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { executeGetWeather } from './service.js';

// Re-export public API from the service module so existing consumers
// (e.g. tests importing from this file) continue to work unchanged.
export { weatherCodeToDescription, weatherCodeToSFSymbol, executeGetWeather } from './service.js';

class GetWeatherTool implements Tool {
  name = 'get_weather';
  description = 'Get current weather conditions and forecast for a location';
  category = 'weather';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The location to get weather for (city name, address, etc.)',
          },
          units: {
            type: 'string',
            enum: ['celsius', 'fahrenheit'],
            description: 'Temperature units to use (default: fahrenheit)',
          },
          days: {
            type: 'number',
            description: 'Number of forecast days to return (1-16, default: 10)',
          },
        },
        required: ['location'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeGetWeather(input, globalThis.fetch, context.proxyToolResolver);
  }
}

registerTool(new GetWeatherTool());
