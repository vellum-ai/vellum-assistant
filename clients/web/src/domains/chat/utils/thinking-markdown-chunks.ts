export interface SplitThinkingMarkdownChunksOptions {
  maxLines?: number;
  maxChars?: number;
}

const DEFAULT_MAX_LINES = 24;
const DEFAULT_MAX_CHARS = 4_000;

interface Fence {
  marker: "`" | "~";
  length: number;
}

function parseFence(line: string): Fence | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/);
  if (!match) return null;
  const fence = match[1]!;
  return {
    marker: fence[0] as Fence["marker"],
    length: fence.length,
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const candidate = parseFence(line);
  return (
    candidate?.marker === fence.marker && candidate.length >= fence.length
  );
}

/**
 * Splits long streamed reasoning into markdown chunks that can be windowed by
 * the thinking drawer. The splitter favors paragraph boundaries, caps long
 * line-oriented runs, and keeps fenced code blocks intact so partial chunks
 * do not render as broken markdown.
 */
export function splitThinkingMarkdownChunks(
  content: string,
  options: SplitThinkingMarkdownChunksOptions = {},
): string[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let openFence: Fence | null = null;

  const flush = () => {
    const chunk = currentLines.join("\n").trimEnd();
    if (chunk.trim().length > 0) {
      chunks.push(chunk);
    }
    currentLines = [];
    currentChars = 0;
  };

  for (const line of content.split("\n")) {
    const fence = parseFence(line);
    const closesOpenFence = openFence ? closesFence(line, openFence) : false;

    currentLines.push(line);
    currentChars += line.length + 1;

    if (openFence && closesOpenFence) {
      openFence = null;
    } else if (!openFence && fence) {
      openFence = fence;
    }

    if (openFence) continue;

    if (line.trim() === "") {
      flush();
      continue;
    }

    if (currentLines.length >= maxLines || currentChars >= maxChars) {
      flush();
    }
  }

  flush();
  return chunks;
}
