import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

function readPackageVersion(): string {
  try {
    const pkgPath = join(import.meta.dir, '../../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

class VersionTool implements Tool {
  name = 'version';
  description = 'Return the current version of the Vellum assistant daemon.';
  category = 'system';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    };
  }

  async execute(_input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const version = readPackageVersion();
    return { content: `Vellum assistant version: ${version}`, isError: false };
  }
}

registerTool(new VersionTool());
