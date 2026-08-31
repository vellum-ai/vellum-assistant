/**
 * Pure helpers for the inbox-management poll. Kept free of process.exit and
 * workspace env so unit tests can import them without running a schedule.
 */

export const STOCK_EXECUTE_MESSAGE =
  "Load the inbox-management skill and run the inbox management pipeline.";

export const PIPELINE_HINT =
  "Load the inbox-management skill and run the inbox management pipeline on the new messages in the attached digest only. Do not re-scan the rest of the inbox or re-judge mail that is not in this digest.";

export type MailBucket = "inbox" | "sent" | "both" | "ignore";

export interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId?: string } }>;
}

export function parseLookbackSeconds(value: string): number {
  const m = /^(\d+)([smhdw]?)$/.exec(value.trim());
  if (!m) {
    throw new Error(
      `Invalid --lookback "${value}": use e.g. 90m, 4h, 2d, 1w, or 0 to disable.`,
    );
  }
  const units: Record<string, number> = {
    "": 1,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
  };
  return Number(m[1]) * units[m[2]];
}

export function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) {
    return undefined;
  }
  const value = argv[idx + 1]?.trim();
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function flagValues(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) {
      continue;
    }
    const value = argv[i + 1]?.trim();
    if (!value) {
      throw new Error(`${name} requires a value.`);
    }
    values.push(value);
  }
  return values;
}

/** New message ids from a Gmail history page, plus the last record id. */
export function collectAddedMessageIds(history: HistoryRecord[]): {
  ids: string[];
  lastRecordId: string | null;
} {
  const ids = new Set<string>();
  let lastRecordId: string | null = null;
  for (const record of history) {
    for (const added of record.messagesAdded ?? []) {
      ids.add(added.message.id);
    }
    lastRecordId = record.id;
  }
  return { ids: [...ids], lastRecordId };
}

export function classifyLabelIds(labelIds: string[] | undefined): MailBucket {
  const labels = new Set(labelIds ?? []);
  const inbox = labels.has("INBOX");
  const sent = labels.has("SENT");
  if (inbox && sent) {
    return "both";
  }
  if (inbox) {
    return "inbox";
  }
  if (sent) {
    return "sent";
  }
  return "ignore";
}

export function isEscalatable(bucket: MailBucket): boolean {
  return bucket !== "ignore";
}

export function shouldEscalate(
  entries: Array<{ bucket: MailBucket }>,
): boolean {
  return entries.some((entry) => isEscalatable(entry.bucket));
}

/** Detect a leftover execute-mode inbox-management job from schedule list JSON. */
export function isStockExecuteInboxSchedule(schedule: {
  mode?: string;
  message?: string;
}): boolean {
  return (
    schedule.mode === "execute" && schedule.message === STOCK_EXECUTE_MESSAGE
  );
}
