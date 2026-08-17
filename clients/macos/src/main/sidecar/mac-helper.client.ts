export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JsonRpcHelperError,
  NativeSidecarClient as MacHelperClient,
} from "@vellumai/native-sidecar/supervisor";
export type {
  JsonRpcErrorPayload,
  JsonRpcId,
  JsonRpcNotification,
  NativeSidecarClientOptions as MacHelperClientOptions,
  NativeSidecarState as MacHelperState,
  NativeSidecarStreamOptions as MacHelperStreamOptions,
} from "@vellumai/native-sidecar/supervisor";
