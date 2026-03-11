/**
 * Extracts REST endpoint templates from a session recording and persists them
 * to disk so the Amazon client can use captured URL patterns instead of
 * stale static fallbacks.
 *
 * Captured requests are saved to ~/.vellum/workspace/data/amazon/captured-requests.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface NetworkRecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
}

interface NetworkRecordedEntry {
  requestId: string;
  resourceType: string;
  timestamp: number;
  request: NetworkRecordedRequest;
  response?: unknown;
}

interface SessionRecording {
  id: string;
  startedAt: number;
  endedAt: number;
  targetDomain?: string;
  networkEntries: NetworkRecordedEntry[];
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    expires?: number;
  }>;
  observations: Array<{
    ocrText: string;
    appName?: string;
    windowTitle?: string;
    timestamp: number;
    captureIndex: number;
  }>;
}

export type AmazonRequestKey =
  | "search"
  | "addToCart"
  | "addToCartFresh"
  | "viewCart"
  | "freshDeliveryWindows"
  | "placeOrder";

export interface CapturedRequest {
  key: AmazonRequestKey;
  method: string;
  urlPattern: string;
  capturedAt: number;
  /** POST body fields extracted from recordings (keys only, values omitted). */
  bodyFields?: string[];
}

function getCapturedRequestsPath(): string {
  return join(process.env.VELLUM_DATA_DIR!, "amazon", "captured-requests.json");
}

/**
 * Classify an Amazon URL to a logical key.
 * Returns null if the URL doesn't match any known pattern.
 */
function classifyUrl(url: string, method: string): AmazonRequestKey | null {
  const withoutQuery = url.split("?")[0];

  if (url.includes("/s?") || /\/s\/[^/]/.test(withoutQuery)) return "search";
  if (withoutQuery.includes("/alm/addtofreshcart") && method === "POST")
    return "addToCartFresh";
  if (
    withoutQuery.includes("/gp/add-to-cart") ||
    withoutQuery.includes("/cart/smart-add")
  )
    return "addToCart";
  // Prefer the lightweight JSON endpoint over the HTML cart page
  if (withoutQuery.includes("/cart/add-to-cart/get-cart-items"))
    return "viewCart";
  if (
    withoutQuery.includes("/gp/cart/view") ||
    withoutQuery.endsWith("/cart/") ||
    withoutQuery.endsWith("/cart")
  )
    return "viewCart";
  if (withoutQuery.includes("/fresh/deliverywindows"))
    return "freshDeliveryWindows";
  if (withoutQuery.includes("/gp/buy/spc") && method === "POST")
    return "placeOrder";

  return null;
}

/**
 * Extract REST endpoint templates from a session recording's network entries.
 * Filters for amazon.com URLs, classifies them, deduplicates by key
 * (keeps last occurrence).
 */
export function extractRequests(
  recording: SessionRecording,
): CapturedRequest[] {
  const byKey = new Map<AmazonRequestKey, CapturedRequest>();

  for (const entry of recording.networkEntries) {
    const url = entry.request.url;
    if (!url.includes("amazon.com")) continue;

    const method = (entry.request.method ?? "GET").toUpperCase();
    const key = classifyUrl(url, method);
    if (!key) continue;

    // Use base URL (without query params) as the pattern
    const urlPattern = url.split("?")[0];

    // Extract field names from JSON POST bodies (values omitted — they're session-specific)
    let bodyFields: string[] | undefined;
    const postData = entry.request.postData;
    if (postData && method === "POST") {
      try {
        const parsed = JSON.parse(postData);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          bodyFields = Object.keys(parsed);
        }
      } catch {
        // form-encoded body — extract field names
        bodyFields = postData
          .split("&")
          .map((p) => decodeURIComponent(p.split("=")[0]))
          .filter(Boolean);
      }
    }

    byKey.set(key, {
      key,
      method,
      urlPattern,
      capturedAt: entry.timestamp,
      ...(bodyFields ? { bodyFields } : {}),
    });
  }

  return Array.from(byKey.values());
}

/**
 * Merge new captured requests with existing ones on disk (newer wins),
 * then write to disk.
 */
export function saveRequests(requests: CapturedRequest[]): string {
  const existing = loadCapturedRequests();

  for (const req of requests) {
    const prev = existing[req.key];
    if (!prev || req.capturedAt >= prev.capturedAt) {
      existing[req.key] = req;
    }
  }

  const filePath = getCapturedRequestsPath();
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
  return filePath;
}

/**
 * Load captured requests from disk. Returns a map keyed by logical key.
 */
export function loadCapturedRequests(): Record<string, CapturedRequest> {
  const filePath = getCapturedRequestsPath();
  if (!existsSync(filePath)) return {};
  try {
    const data = readFileSync(filePath, "utf-8");
    return JSON.parse(data) as Record<string, CapturedRequest>;
  } catch {
    return {};
  }
}
