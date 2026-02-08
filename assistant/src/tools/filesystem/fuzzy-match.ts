export type MatchMethod = 'exact' | 'whitespace' | 'fuzzy';

export interface MatchResult {
  start: number;
  end: number;
  matched: string;
  similarity: number;
  method: MatchMethod;
}

interface IndexedLine {
  text: string;
  start: number;
  end: number;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function lineSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function normalizeLines(str: string): string[] {
  return str.split('\n').map(line => line.trim());
}

function indexLines(content: string): IndexedLine[] {
  const lines: IndexedLine[] = [];
  let pos = 0;
  for (const text of content.split('\n')) {
    lines.push({ text, start: pos, end: pos + text.length });
    pos += text.length + 1; // +1 for the newline
  }
  return lines;
}

function tryExactMatch(content: string, target: string): MatchResult | null {
  const idx = content.indexOf(target);
  if (idx === -1) return null;
  return { start: idx, end: idx + target.length, matched: content.slice(idx, idx + target.length), similarity: 1, method: 'exact' };
}

function findAllExactMatches(content: string, target: string): MatchResult[] {
  const results: MatchResult[] = [];
  let idx = content.indexOf(target);
  while (idx !== -1) {
    results.push({ start: idx, end: idx + target.length, matched: content.slice(idx, idx + target.length), similarity: 1, method: 'exact' });
    idx = content.indexOf(target, idx + 1);
  }
  return results;
}

function tryWhitespaceMatch(contentLines: IndexedLine[], targetNorm: string[]): MatchResult[] {
  const results: MatchResult[] = [];
  const windowSize = targetNorm.length;
  if (windowSize === 0 || contentLines.length < windowSize) return results;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    let allMatch = true;
    for (let j = 0; j < windowSize; j++) {
      if (contentLines[i + j].text.trim() !== targetNorm[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      const start = contentLines[i].start;
      const lastLine = contentLines[i + windowSize - 1];
      const end = lastLine.end;
      results.push({
        start,
        end,
        matched: contentLines.slice(i, i + windowSize).map(l => l.text).join('\n'),
        similarity: 1,
        method: 'whitespace',
      });
    }
  }
  return results;
}

function tryFuzzyMatch(contentLines: IndexedLine[], targetNorm: string[], threshold: number): MatchResult[] {
  const results: MatchResult[] = [];
  const windowSize = targetNorm.length;
  if (windowSize === 0 || contentLines.length < windowSize) return results;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    let totalSimilarity = 0;
    for (let j = 0; j < windowSize; j++) {
      totalSimilarity += lineSimilarity(contentLines[i + j].text.trim(), targetNorm[j]);
    }
    const avgSimilarity = totalSimilarity / windowSize;
    if (avgSimilarity >= threshold) {
      const start = contentLines[i].start;
      const lastLine = contentLines[i + windowSize - 1];
      const end = lastLine.end;
      results.push({
        start,
        end,
        matched: contentLines.slice(i, i + windowSize).map(l => l.text).join('\n'),
        similarity: avgSimilarity,
        method: 'fuzzy',
      });
    }
  }
  return results;
}

const FUZZY_THRESHOLD = 0.8;

export function findMatch(content: string, target: string): MatchResult | null {
  // 1. Exact match
  const exact = tryExactMatch(content, target);
  if (exact) return exact;

  const contentLines = indexLines(content);
  const targetNorm = normalizeLines(target);

  // 2. Whitespace-normalized match
  const wsMatches = tryWhitespaceMatch(contentLines, targetNorm);
  if (wsMatches.length === 1) return wsMatches[0];
  if (wsMatches.length > 1) return wsMatches[0]; // findAllMatches handles ambiguity

  // 3. Fuzzy/Levenshtein match
  const fuzzyMatches = tryFuzzyMatch(contentLines, targetNorm, FUZZY_THRESHOLD);
  if (fuzzyMatches.length === 0) return null;

  // Return best match
  fuzzyMatches.sort((a, b) => b.similarity - a.similarity);
  return fuzzyMatches[0];
}

export function findAllMatches(content: string, target: string): MatchResult[] {
  // 1. Exact matches
  const exactMatches = findAllExactMatches(content, target);
  if (exactMatches.length > 0) return exactMatches;

  const contentLines = indexLines(content);
  const targetNorm = normalizeLines(target);

  // 2. Whitespace-normalized matches
  const wsMatches = tryWhitespaceMatch(contentLines, targetNorm);
  if (wsMatches.length > 0) return wsMatches;

  // 3. Fuzzy matches
  const fuzzyMatches = tryFuzzyMatch(contentLines, targetNorm, FUZZY_THRESHOLD);
  fuzzyMatches.sort((a, b) => b.similarity - a.similarity);
  return fuzzyMatches;
}

function getLeadingWhitespace(line: string): string {
  const match = line.match(/^(\s*)/);
  return match ? match[1] : '';
}

function findFirstNonEmptyLine(str: string): string | null {
  for (const line of str.split('\n')) {
    if (line.trim().length > 0) return line;
  }
  return null;
}

export function adjustIndentation(oldString: string, matched: string, newString: string): string {
  const oldLine = findFirstNonEmptyLine(oldString);
  const matchedLine = findFirstNonEmptyLine(matched);
  if (!oldLine || !matchedLine) return newString;

  const oldIndent = getLeadingWhitespace(oldLine);
  const matchedIndent = getLeadingWhitespace(matchedLine);
  if (oldIndent === matchedIndent) return newString;

  // Compute the difference: how many chars to add/remove
  const oldLen = oldIndent.length;
  const matchedLen = matchedIndent.length;

  return newString.split('\n').map(line => {
    if (line.trim().length === 0) return line;
    const currentIndent = getLeadingWhitespace(line);
    if (matchedLen > oldLen) {
      // File has more indentation — add the difference
      const diff = matchedIndent.slice(0, matchedLen - oldLen);
      return diff + line;
    } else {
      // File has less indentation — remove the difference
      const removeCount = oldLen - matchedLen;
      if (currentIndent.length >= removeCount) {
        return line.slice(removeCount);
      }
      return line;
    }
  }).join('\n');
}
