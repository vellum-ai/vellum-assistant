import { Buffer } from "node:buffer";
import { buildUpstreamUrl, stripHopByHop } from "@vellumai/assistant-client";

import { fetchImpl } from "../fetch.js";
import {
  formatRawQuery,
  headersFromVelay,
  headersToVelay,
  isBase64,
  isSafeOriginRelativePath,
} from "./bridge-utils.js";
import {
  VELAY_FRAME_TYPES,
  type VelayHttpRequestFrame,
  type VelayHttpResponseFrame,
} from "./protocol.js";

const BAD_GATEWAY_BODY = JSON.stringify({ error: "Bad Gateway" });

export async function bridgeVelayHttpRequest(
  frame: VelayHttpRequestFrame,
  gatewayLoopbackBaseUrl: string,
): Promise<VelayHttpResponseFrame> {
  const url = buildLoopbackUrl(gatewayLoopbackBaseUrl, frame);
  if (!url) return badGatewayFrame(frame.request_id);

  const body = decodeBody(frame.body_base64);
  if (!body.ok) return badGatewayFrame(frame.request_id);

  const request = buildLoopbackRequest(frame, url, body.value);
  if (!request) return badGatewayFrame(frame.request_id);

  let response: Response;
  try {
    response = await fetchImpl(request);
  } catch {
    return badGatewayFrame(frame.request_id);
  }

  return {
    type: VELAY_FRAME_TYPES.httpResponse,
    request_id: frame.request_id,
    status_code: response.status,
    headers: headersToVelay(stripHopByHop(new Headers(response.headers))),
    body_base64: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

function buildLoopbackRequest(
  frame: VelayHttpRequestFrame,
  url: string,
  body: ArrayBuffer | undefined,
): Request | undefined {
  try {
    const headers = headersFromVelay(frame.headers);
    if (body !== undefined) {
      headers.set("content-length", String(body.byteLength));
    } else {
      headers.delete("content-length");
    }

    return new Request(url, {
      method: frame.method,
      headers,
      body,
    });
  } catch {
    return undefined;
  }
}

function buildLoopbackUrl(
  gatewayLoopbackBaseUrl: string,
  frame: VelayHttpRequestFrame,
): string | undefined {
  if (!isSafeOriginRelativePath(frame.path)) return undefined;
  return buildUpstreamUrl(
    gatewayLoopbackBaseUrl,
    frame.path,
    formatRawQuery(frame.raw_query),
  );
}

function decodeBody(
  bodyBase64: string | undefined,
): { ok: true; value?: ArrayBuffer } | { ok: false } {
  if (!bodyBase64) return { ok: true };
  if (!isBase64(bodyBase64)) {
    return { ok: false };
  }
  const bytes = Buffer.from(bodyBase64, "base64");
  return {
    ok: true,
    value: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
}

function badGatewayFrame(requestId: string): VelayHttpResponseFrame {
  return {
    type: VELAY_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: 502,
    headers: { "content-type": ["application/json"] },
    body_base64: Buffer.from(BAD_GATEWAY_BODY).toString("base64"),
  };
}
