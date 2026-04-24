/**
 * @vellumai/assistant-client
 *
 * Shared gateway-to-assistant-runtime client helpers. This package provides
 * reusable transport primitives for HTTP proxy forwarding and WebSocket
 * upstream construction without coupling to gateway auth internals or
 * runtime application logic.
 */

export {
  stripHopByHop,
  buildUpstreamUrl,
  prepareUpstreamHeaders,
  createTimeoutController,
  isTimeoutError,
  isConnectionError,
} from "./http-client.js";

export {
  proxyForward,
  proxyForwardToResponse,
  type ProxyForwardOptions,
  type ProxyForwardResult,
} from "./proxy-forward.js";

export {
  httpToWs,
  buildWsUpstreamUrl,
  type WsUpstreamOptions,
  type WsUpstreamResult,
} from "./websocket-upstream.js";
