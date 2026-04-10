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

export interface CliInput<TPayload> {
  args: ParsedArgs;
  payload: TPayload;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }

    out[key] = next;
    i += 1;
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
): Promise<CliInput<TPayload>> {
  const args = parseArgs(argv);

  const inputJson =
    typeof args["input-json"] === "string" ? args["input-json"] : null;
  if (inputJson) {
    return {
      args,
      payload: JSON.parse(inputJson) as TPayload,
    };
  }

  const stdin = (await readStdin()).trim();
  if (stdin.length > 0) {
    return {
      args,
      payload: JSON.parse(stdin) as TPayload,
    };
  }

  return {
    args,
    payload: fallback,
  };
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const lowered = value.toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
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

export function extractAsins(input: string): string[] {
  const matches = input.toUpperCase().match(/\b[A-Z0-9]{10}\b/g) ?? [];
  const filtered = matches.filter(
    (token) => /[A-Z]/.test(token) && /\d/.test(token),
  );
  return Array.from(new Set(filtered));
}

export function extractAsinsFromLinks(links: string[]): string[] {
  const asins: string[] = [];
  for (const link of links) {
    const match = link.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (match) asins.push(match[1].toUpperCase());
  }
  return Array.from(new Set(asins));
}

export function parsePrice(input: string): number | null {
  const match = input.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!match) return null;
  const numeric = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export function printError(message: string): void {
  printJson({ ok: false, error: message });
  process.exitCode = 1;
}

export function safeArrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}
