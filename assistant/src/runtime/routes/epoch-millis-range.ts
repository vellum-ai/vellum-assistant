import { BadRequestError } from "./errors.js";

export interface EpochMillisRange {
  from: number;
  to: number;
}

export function parseEpochMillisRange(
  queryParams: Record<string, string>,
): EpochMillisRange {
  const fromRaw = queryParams.from;
  const toRaw = queryParams.to;

  if (!fromRaw || !toRaw) {
    throw new BadRequestError(
      'Missing required query parameters: "from" and "to" (epoch milliseconds)',
    );
  }

  const from = Number(fromRaw);
  const to = Number(toRaw);

  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new BadRequestError(
      '"from" and "to" must be valid numbers (epoch milliseconds)',
    );
  }

  if (from > to) {
    throw new BadRequestError('"from" must be less than or equal to "to"');
  }

  return { from, to };
}
