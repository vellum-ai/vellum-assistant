export interface ParsedArgs {
  [key: string]: string | boolean;
}

export interface HelperEnvelope<TContext = Record<string, unknown>> {
  phase?: string;
  context?: TContext;
  extracted?: {
    text?: string;
    links?: string[];
    snapshotHints?: string[];
  };
  userIntent?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }

    out[key] = next;
    index += 1;
  }
  return out;
}

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

export async function parseCliInput<TPayload>(
  argv: string[],
  fallback: TPayload,
): Promise<{ args: ParsedArgs; payload: TPayload }> {
  const args = parseArgs(argv);

  const inputJson = typeof args["input-json"] === "string" ? args["input-json"] : null;
  if (inputJson) {
    return { args, payload: JSON.parse(inputJson) as TPayload };
  }

  const stdin = (await readStdin()).trim();
  if (stdin.length > 0) {
    return { args, payload: JSON.parse(stdin) as TPayload };
  }

  return { args, payload: fallback };
}

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export function printError(message: string): void {
  printJson({ ok: false, error: message });
  process.exitCode = 1;
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function toLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const lowered = value.toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

export function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function parseFollowerCount(input: string): number | undefined {
  const cleaned = normalizeWhitespace(input)
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/followers?/g, "")
    .trim();

  const match = cleaned.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmbt]?)/i);
  if (!match) return undefined;

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;

  const suffix = (match[2] ?? "").toLowerCase();
  const multipliers: Record<string, number> = {
    "": 1,
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };

  return Math.round(value * (multipliers[suffix] ?? 1));
}
