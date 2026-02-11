import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('system-info');

const VALID_SECTIONS = ['memory', 'cpu', 'disk', 'battery', 'uptime', 'os'] as const;
type Section = (typeof VALID_SECTIONS)[number];

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);

  return parts.join(', ');
}

function getMemorySection(): string {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percentage = Math.round((used / total) * 100);

  return `### Memory\nTotal: ${formatBytes(total)} | Used: ${formatBytes(used)} | Free: ${formatBytes(free)} (${percentage}% used)`;
}

function getCpuSection(): string {
  const cpus = os.cpus();
  const model = cpus.length > 0 ? cpus[0].model : 'Unknown';
  const cores = cpus.length;
  const loadAvg = os.loadavg();

  return `### CPU\n${model} (${cores} cores)\nLoad Average: ${loadAvg[0].toFixed(2)}, ${loadAvg[1].toFixed(2)}, ${loadAvg[2].toFixed(2)}`;
}

function getDiskSection(): string {
  try {
    const output = execSync('df -h /', { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    if (lines.length < 2) {
      return '### Disk (/)\nUnable to parse disk information';
    }

    // df -h output varies by platform but generally:
    // Filesystem  Size  Used  Avail  Use%  Mounted
    const dataLine = lines[1];
    const parts = dataLine.split(/\s+/);

    // On macOS: Filesystem Size Used Avail Capacity iused ifree %iused Mounted
    // On Linux: Filesystem Size Used Avail Use% Mounted
    // We need to find Size, Used, Avail, and percentage
    if (parts.length >= 5) {
      const size = parts[1];
      const used = parts[2];
      const avail = parts[3];
      const capacity = parts[4];

      return `### Disk (/)\nTotal: ${size} | Used: ${used} | Available: ${avail} (${capacity} used)`;
    }

    return '### Disk (/)\nUnable to parse disk information';
  } catch (err) {
    log.debug({ err }, 'Failed to get disk info');
    return '### Disk (/)\nUnable to retrieve disk information';
  }
}

function getBatterySection(): string {
  try {
    const output = execSync('pmset -g batt', { encoding: 'utf8', timeout: 5000 });

    // Parse percentage: look for pattern like "85%"
    const percentMatch = /(\d+)%/.exec(output);
    if (!percentMatch) {
      return '### Battery\nNo battery information available';
    }
    const percent = percentMatch[1];

    // Parse state: "charging", "discharging", "charged", "AC attached"
    let state = 'Unknown';
    if (/charging/i.test(output) && !/discharging/i.test(output) && !/not charging/i.test(output)) {
      state = 'Charging';
    } else if (/discharging/i.test(output)) {
      state = 'Discharging';
    } else if (/charged/i.test(output)) {
      state = 'Charged';
    } else if (/AC attached/i.test(output) || /not charging/i.test(output)) {
      state = 'AC Power';
    }

    return `### Battery\n${percent}% \u2014 ${state}`;
  } catch (err) {
    log.debug({ err }, 'Failed to get battery info');
    return '### Battery\nNo battery information available';
  }
}

function getUptimeSection(): string {
  const uptime = os.uptime();
  return `Uptime: ${formatUptime(uptime)}`;
}

function getOsSection(): string {
  return `OS: ${os.type()} ${os.release()} (${os.arch()})`;
}

export function buildSystemInfo(sections?: string[]): string {
  const hostname = os.hostname();
  const requestedSections: Section[] = sections && sections.length > 0
    ? sections.filter((s): s is Section => VALID_SECTIONS.includes(s as Section))
    : [...VALID_SECTIONS];

  if (requestedSections.length === 0) {
    return 'Error: No valid sections specified. Valid sections: ' + VALID_SECTIONS.join(', ');
  }

  const lines: string[] = [`## System Info \u2014 ${hostname}`];

  // OS and uptime go in the header area
  if (requestedSections.includes('os')) {
    lines.push(getOsSection());
  }
  if (requestedSections.includes('uptime')) {
    lines.push(getUptimeSection());
  }

  // Add a blank line before detail sections
  const detailSections: Section[] = ['memory', 'cpu', 'disk', 'battery'];
  const hasDetails = detailSections.some((s) => requestedSections.includes(s));
  if (hasDetails) {
    lines.push('');
  }

  if (requestedSections.includes('memory')) {
    lines.push(getMemorySection());
  }
  if (requestedSections.includes('cpu')) {
    lines.push(getCpuSection());
  }
  if (requestedSections.includes('disk')) {
    lines.push(getDiskSection());
  }
  if (requestedSections.includes('battery')) {
    lines.push(getBatterySection());
  }

  return lines.join('\n');
}

class SystemInfoTool implements Tool {
  name = 'system_info';
  description = 'Get current system information including CPU, memory, disk, battery, and uptime';
  category = 'system';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional filter for which sections to return. Valid sections: "memory", "cpu", "disk", "battery", "uptime", "os". Defaults to all sections.',
          },
        },
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    try {
      const sections = Array.isArray(input.sections) ? input.sections.filter((s): s is string => typeof s === 'string') : undefined;
      const content = buildSystemInfo(sections);
      return { content, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'system_info failed');
      return { content: `Error: Failed to gather system info: ${msg}`, isError: true };
    }
  }
}

registerTool(new SystemInfoTool());
