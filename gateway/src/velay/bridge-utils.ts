import { Buffer } from "node:buffer";
import type { OutgoingHttpHeaders } from "node:http";
import { buildUpstreamUrl, stripHopByHop } from "@vellumai/assistant-client";

import type { VelayHeaders } from "./protocol.js";

const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

export function isSafeOriginRelativePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\") || path.includes("?") || path.includes("#")) {
    return false;
  }
  try {
    const parsed = new URL(path, "http://127.0.0.1");
    return parsed.origin === "http://127.0.0.1" && parsed.pathname === path;
  } catch {
    return false;
  }
}

export function formatRawQuery(rawQuery: string | undefined): string {
  if (!rawQuery) return "";
  return `?${rawQuery.replace(/^\?/, "")}`;
}

export function buildLoopbackHttpUrl(
  gatewayLoopbackBaseUrl: string,
  path: string,
  rawQuery?: string,
): string | undefined {
  if (!isSafeOriginRelativePath(path)) return undefined;
  return buildUpstreamUrl(
    gatewayLoopbackBaseUrl,
    path,
    formatRawQuery(rawQuery),
  );
}

export function buildLoopbackWebSocketUrl(
  gatewayLoopbackBaseUrl: string,
  path: string,
  rawQuery?: string,
): string | undefined {
  const httpUrl = buildLoopbackHttpUrl(gatewayLoopbackBaseUrl, path, rawQuery);
  if (!httpUrl) return undefined;

  try {
    const url = new URL(httpUrl);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function headersToWeb(headers: VelayHeaders): Headers {
  const webHeaders = new Headers();
  for (const [name, values] of Object.entries(headers)) {
    for (const value of values) {
      webHeaders.append(name, value);
    }
  }
  return webHeaders;
}

export function headersToVelay(headers: Headers): VelayHeaders {
  const velayHeaders: VelayHeaders = {};
  for (const [name, value] of headers.entries()) {
    velayHeaders[name] ??= [];
    velayHeaders[name].push(value);
  }
  return velayHeaders;
}

export function headersFromVelay(headers: VelayHeaders): Headers {
  return stripHopByHop(headersToWeb(headers));
}

export function websocketHeadersFromVelay(
  headers: VelayHeaders,
): OutgoingHttpHeaders {
  const cleaned = headersFromVelay(headers);
  const outgoing: OutgoingHttpHeaders = {};

  for (const [name, value] of cleaned.entries()) {
    if (name.startsWith("sec-websocket-")) continue;
    outgoing[name] = value;
  }
  return outgoing;
}

export function isBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    value,
  );
}

export function decodeBase64Bytes(value: string): Uint8Array | undefined {
  if (!isBase64(value)) return undefined;
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function decodeOptionalBase64ArrayBuffer(
  value: string | undefined,
): { ok: true; value?: ArrayBuffer } | { ok: false } {
  if (!value) return { ok: true };

  const bytes = decodeBase64Bytes(value);
  if (bytes === undefined) return { ok: false };
  return { ok: true, value: bytesToArrayBuffer(bytes) };
}

export function encodeBase64(value: string | ArrayBuffer | Uint8Array): string {
  if (typeof value === "string") return Buffer.from(value).toString("base64");
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("base64");
  }
  return Buffer.from(value).toString("base64");
}

export async function binaryLikeToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return Buffer.from(String(data));
}

export function closeWebSocket(
  ws: WebSocket,
  code?: number,
  reason?: string,
): void {
  if (
    ws.readyState !== WebSocket.OPEN &&
    ws.readyState !== WebSocket.CONNECTING
  ) {
    return;
  }

  const closeArgs = sanitizeWebSocketCloseArgs(code, reason);
  try {
    if (!closeArgs) {
      ws.close();
      return;
    }
    ws.close(closeArgs.code, closeArgs.reason);
  } catch {
    try {
      ws.close();
    } catch {
      // The socket is already closing or the runtime rejected the close call.
    }
  }
}

export function sanitizeWebSocketCloseArgs(
  code?: number,
  reason?: string,
): { code: number; reason?: string } | undefined {
  const safeCode = toSafeWebSocketCloseCode(code);
  if (safeCode === undefined) return undefined;

  const sanitizedReason =
    typeof reason === "string" ? truncateCloseReason(reason) : undefined;
  return sanitizedReason === undefined
    ? { code: safeCode }
    : { code: safeCode, reason: sanitizedReason };
}

function toSafeWebSocketCloseCode(
  code: number | undefined,
): number | undefined {
  if (typeof code !== "number" || !Number.isInteger(code)) return undefined;
  if (code === 1000) return code;
  if (code >= 3000 && code <= 4999) return code;
  // WebSocket close events can report these RFC 6455 codes, but the
  // JavaScript close() API only portably accepts 1000 or 3000-4999.
  if (isRemappableProtocolCloseCode(code)) return 3000 + code;
  return undefined;
}

function isRemappableProtocolCloseCode(code: number): boolean {
  return (
    code === 1001 ||
    code === 1002 ||
    code === 1003 ||
    (code >= 1007 && code <= 1014)
  );
}

function truncateCloseReason(reason: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(reason).byteLength <= MAX_WEBSOCKET_CLOSE_REASON_BYTES) {
    return reason;
  }

  let truncated = "";
  let byteLength = 0;
  for (const character of reason) {
    const characterLength = encoder.encode(character).byteLength;
    if (byteLength + characterLength > MAX_WEBSOCKET_CLOSE_REASON_BYTES) break;
    truncated += character;
    byteLength += characterLength;
  }
  return truncated;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}
