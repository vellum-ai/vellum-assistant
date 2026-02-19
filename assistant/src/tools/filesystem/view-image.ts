import { execSync } from 'node:child_process';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { ImageContent, ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// Images above this threshold get auto-optimized via sips (macOS) to avoid
// sending multi-MB base64 payloads to the LLM API.
const OPTIMIZE_THRESHOLD_BYTES = 1 * 1024 * 1024; // 1 MB
const OPTIMIZE_MAX_DIMENSION = 1568; // Anthropic's recommended max
const OPTIMIZE_JPEG_QUALITY = 80;

/**
 * Use macOS `sips` to resize and convert an image to JPEG.
 * Returns the path to the optimized temp file, or null if sips is unavailable.
 */
function optimizeWithSips(srcPath: string): string | null {
  const tmpPath = join(tmpdir(), `vellum-view-image-${Date.now()}.jpg`);
  try {
    execSync(
      `sips --resampleHeightWidthMax ${OPTIMIZE_MAX_DIMENSION} -s format jpeg -s formatOptions ${OPTIMIZE_JPEG_QUALITY} ${JSON.stringify(srcPath)} --out ${JSON.stringify(tmpPath)}`,
      { stdio: 'pipe', timeout: 15_000 },
    );
    return tmpPath;
  } catch {
    return null;
  }
}

class ViewImageTool implements Tool {
  name = 'view_image';
  description =
    'Read an image file from the filesystem and return it for visual analysis. Supports JPEG, PNG, GIF, and WebP.';
  category = 'filesystem';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'The path to the image file (absolute or relative to working directory)',
          },
        },
        required: ['path'],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const rawPath = input.path as string;
    if (!rawPath || typeof rawPath !== 'string') {
      return { content: 'Error: path is required and must be a string', isError: true };
    }

    const resolved = resolve(context.workingDir, rawPath);

    const ext = extname(resolved).toLowerCase();
    const mediaType = SUPPORTED_EXTENSIONS[ext];
    if (!mediaType) {
      const supported = Object.keys(SUPPORTED_EXTENSIONS).join(', ');
      return {
        content: `Error: unsupported image format "${ext}". Supported: ${supported}`,
        isError: true,
      };
    }

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      return { content: `Error: file not found: ${resolved}`, isError: true };
    }

    if (!stat.isFile()) {
      return { content: `Error: ${resolved} is not a file`, isError: true };
    }

    if (stat.size > MAX_SIZE_BYTES) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      return {
        content: `Error: image too large (${sizeMB} MB). Maximum is 20 MB.`,
        isError: true,
      };
    }

    let buffer: Buffer;
    let finalMediaType = mediaType;
    let optimized = false;
    let tmpPath: string | null = null;

    try {
      if (stat.size > OPTIMIZE_THRESHOLD_BYTES) {
        tmpPath = optimizeWithSips(resolved);
        if (tmpPath) {
          buffer = readFileSync(tmpPath) as Buffer;
          finalMediaType = 'image/jpeg';
          optimized = true;
        } else {
          buffer = readFileSync(resolved) as Buffer;
        }
      } else {
        buffer = readFileSync(resolved) as Buffer;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error reading file: ${msg}`, isError: true };
    } finally {
      if (tmpPath) {
        try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
      }
    }

    const base64Data = buffer.toString('base64');

    const imageBlock: ImageContent = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: finalMediaType,
        data: base64Data,
      },
    };

    const sizeSuffix = optimized
      ? ` (optimized from ${(stat.size / 1024).toFixed(0)} KB to ${(buffer.length / 1024).toFixed(0)} KB)`
      : '';

    return {
      content: `Image loaded: ${resolved} (${buffer.length} bytes, ${finalMediaType})${sizeSuffix}`,
      isError: false,
      contentBlocks: [imageBlock],
    };
  }
}

registerTool(new ViewImageTool());
