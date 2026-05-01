import { stripHopByHop } from "@vellumai/assistant-client";

import { fetchImpl } from "../fetch.js";
import {
  buildLoopbackHttpUrl,
  decodeOptionalBase64ArrayBuffer,
  encodeBase64,
  headersFromVelay,
  headersToVelay,
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
  const url = buildLoopbackHttpUrl(
    gatewayLoopbackBaseUrl,
    frame.path,
    frame.raw_query,
  );
  if (!url) return badGatewayFrame(frame.request_id);

  const body = decodeOptionalBase64ArrayBuffer(frame.body_base64);
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
    body_base64: encodeBase64(await response.arrayBuffer()),
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

function badGatewayFrame(requestId: string): VelayHttpResponseFrame {
  return {
    type: VELAY_FRAME_TYPES.httpResponse,
    request_id: requestId,
    status_code: 502,
    headers: { "content-type": ["application/json"] },
    body_base64: encodeBase64(BAD_GATEWAY_BODY),
  };
}
