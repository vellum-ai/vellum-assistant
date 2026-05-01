import type { OutgoingHttpHeaders } from "node:http";
import { stripHopByHop } from "@vellumai/assistant-client";

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
  if (code === 1000) return code;
  if (typeof code !== "number" || !Number.isInteger(code)) return undefined;
  if (code >= 3000 && code <= 4999) return code;
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
