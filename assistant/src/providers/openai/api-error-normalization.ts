import OpenAI from "openai";

export interface NormalizedOpenAIAPIError {
  message: string;
  detail?: string;
  requestId?: string;
  apiErrorCode?: string;
  apiErrorType?: string;
  apiErrorParam?: string;
}

interface ErrorBodyDetails {
  message?: string;
  detail?: string;
  apiErrorCode?: string;
  apiErrorType?: string;
  apiErrorParam?: string;
}

const MAX_API_ERROR_DETAIL_CHARS = 2000;
const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-openrouter-request-id",
  "openai-request-id",
  "x-amzn-requestid",
] as const;

export async function readOpenAIRawErrorBody(
  response: Response,
): Promise<string | undefined> {
  if (response.ok) return undefined;
  try {
    return await response.clone().text();
  } catch {
    return undefined;
  }
}

export function normalizeOpenAIAPIError(
  error: InstanceType<typeof OpenAI.APIError>,
  rawBody?: string,
): NormalizedOpenAIAPIError {
  const rawDetails = parseRawErrorBody(rawBody);
  const sdkDetails = extractErrorBodyDetails(
    (error as { error?: unknown }).error,
  );
  const message =
    rawDetails?.message ??
    sdkDetails?.message ??
    stripLeadingStatus(error.message ?? "", error.status) ??
    "Request failed";
  const detail = firstDistinctDetail(
    message,
    rawDetails?.detail,
    sdkDetails?.detail,
  );
  const requestId = readHeader(error.headers, REQUEST_ID_HEADERS);
  return {
    message,
    ...(detail !== undefined ? { detail } : {}),
    ...mergeApiMetadata(error, rawDetails, sdkDetails),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

export function formatNormalizedOpenAIAPIError(
  providerLabel: string,
  status: number | undefined,
  normalized: NormalizedOpenAIAPIError,
): string {
  const statusLabel =
    typeof status === "number" ? String(status) : "unknown status";
  const extras = [
    normalized.detail,
    normalized.apiErrorCode ? `code=${normalized.apiErrorCode}` : undefined,
    normalized.apiErrorType ? `type=${normalized.apiErrorType}` : undefined,
    normalized.apiErrorParam ? `param=${normalized.apiErrorParam}` : undefined,
    normalized.requestId ? `request_id=${normalized.requestId}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const suffix = extras.length > 0 ? ` [${extras.join("; ")}]` : "";
  return `${providerLabel} API error (${statusLabel}): ${normalized.message}${suffix}`;
}

/**
 * Exported for tests and for older call sites that only need a serialized
 * detail string plus request id.
 */
export function extractApiErrorDetail(
  error: InstanceType<typeof OpenAI.APIError>,
  rawBody?: string,
): { detail: string; requestId: string | undefined } {
  const normalized = normalizeOpenAIAPIError(error, rawBody);
  const detail = firstDistinctDetail(
    stripLeadingStatus(error.message ?? "", error.status) ?? "",
    normalized.message,
    normalized.detail,
  );
  return { detail: detail ?? "", requestId: normalized.requestId };
}

function parseRawErrorBody(
  rawBody: string | undefined,
): ErrorBodyDetails | undefined {
  const trimmed = rawBody?.trim();
  if (!trimmed) return undefined;
  try {
    return extractErrorBodyDetails(JSON.parse(trimmed));
  } catch {
    return { message: truncateDetail(trimmed) };
  }
}

function extractErrorBodyDetails(body: unknown): ErrorBodyDetails | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") {
    const message = truncateDetail(body.trim());
    return message ? { message } : undefined;
  }
  const record = asRecord(body);
  if (!record) return undefined;

  const wrappedError = record.error;
  if (typeof wrappedError === "string") {
    const details: ErrorBodyDetails = { message: truncateDetail(wrappedError) };
    addApiMetadata(details, record);
    return details;
  }
  const wrappedRecord = asRecord(wrappedError);
  if (wrappedRecord) {
    const nested = extractErrorRecordDetails(wrappedRecord);
    addApiMetadata(nested, record);
    return nested;
  }

  return extractErrorRecordDetails(record);
}

function extractErrorRecordDetails(
  record: Record<string, unknown>,
): ErrorBodyDetails {
  const detail = stringProp(record, "detail");
  const message = stringProp(record, "message") ?? detail;
  const metadata = asRecord(record.metadata);
  const raw = stringProp(metadata, "raw");
  const providerName = stringProp(metadata, "provider_name");
  const normalizedMessage =
    raw && message && isGenericProviderErrorMessage(message)
      ? raw
      : (message ?? raw);
  const metadataDetails = [
    raw && raw !== normalizedMessage ? raw : undefined,
    providerName ? `provider=${providerName}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const metadataDetail =
    metadataDetails.length > 0 ? metadataDetails.join("; ") : undefined;

  const details: ErrorBodyDetails = {};
  if (normalizedMessage) {
    details.message = truncateDetail(normalizedMessage);
  }
  if (metadataDetail) {
    details.detail = truncateDetail(metadataDetail);
  }
  addApiMetadata(details, record);
  return details;
}

function mergeApiMetadata(
  error: InstanceType<typeof OpenAI.APIError>,
  rawDetails: ErrorBodyDetails | undefined,
  sdkDetails: ErrorBodyDetails | undefined,
): Pick<
  NormalizedOpenAIAPIError,
  "apiErrorCode" | "apiErrorType" | "apiErrorParam"
> {
  const metadata: Pick<
    NormalizedOpenAIAPIError,
    "apiErrorCode" | "apiErrorType" | "apiErrorParam"
  > = {};
  const apiErrorCode =
    rawDetails?.apiErrorCode ??
    sdkDetails?.apiErrorCode ??
    scalarString((error as { code?: unknown }).code);
  const apiErrorType =
    rawDetails?.apiErrorType ??
    sdkDetails?.apiErrorType ??
    scalarString((error as { type?: unknown }).type);
  const apiErrorParam =
    rawDetails?.apiErrorParam ??
    sdkDetails?.apiErrorParam ??
    scalarString((error as { param?: unknown }).param);
  if (apiErrorCode !== undefined) metadata.apiErrorCode = apiErrorCode;
  if (apiErrorType !== undefined) metadata.apiErrorType = apiErrorType;
  if (apiErrorParam !== undefined) metadata.apiErrorParam = apiErrorParam;
  return metadata;
}

function addApiMetadata(
  details: ErrorBodyDetails,
  record: Record<string, unknown>,
): void {
  if (details.apiErrorCode === undefined) {
    const code = scalarString(record.code);
    if (code !== undefined) details.apiErrorCode = code;
  }
  if (details.apiErrorType === undefined) {
    const type = scalarString(record.type);
    if (type !== undefined) details.apiErrorType = type;
  }
  if (details.apiErrorParam === undefined) {
    const param = scalarString(record.param);
    if (param !== undefined) details.apiErrorParam = param;
  }
}

function firstDistinctDetail(
  message: string,
  ...details: Array<string | undefined>
): string | undefined {
  for (const detail of details) {
    if (!detail) continue;
    const trimmed = truncateDetail(detail.trim());
    if (trimmed && trimmed !== message) return trimmed;
  }
  return undefined;
}

function stripLeadingStatus(
  message: string,
  status: number | undefined,
): string | undefined {
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  if (typeof status !== "number") return trimmed;
  return trimmed.replace(new RegExp(`^${status}\\s+`), "").trim() || trimmed;
}

function truncateDetail(detail: string): string {
  return detail.length > MAX_API_ERROR_DETAIL_CHARS
    ? `${detail.slice(0, MAX_API_ERROR_DETAIL_CHARS)}…`
    : detail;
}

function isGenericProviderErrorMessage(message: string): boolean {
  return /^provider returned error$/i.test(message.trim());
}

function stringProp(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readHeader(
  headers: unknown,
  names: readonly string[],
): string | undefined {
  if (!headers) return undefined;
  const getter =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get.bind(headers)
      : undefined;
  for (const name of names) {
    let value: string | null | undefined;
    if (getter) {
      value = getter(name);
    } else if (typeof headers === "object") {
      const record = headers as Record<string, unknown>;
      const raw = record[name] ?? record[name.toLowerCase()];
      value = typeof raw === "string" ? raw : undefined;
    }
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
