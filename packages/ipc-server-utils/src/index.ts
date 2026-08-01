export {
  SocketWatchdog,
  ensureSocketDir,
  type SocketWatchdogOptions,
  type SocketWatchdogLogger,
} from "./socket-watchdog.js";
export {
  isNamedPipePath,
  removeIpcEndpointFile,
  resolveIpcEndpoint,
  WINDOWS_NAMED_PIPE_MAX_PATH_CHARS,
  type IpcEndpointOptions,
  type IpcEndpointResolution,
  type IpcEndpointSource,
} from "./endpoint.js";
export {
  IpcFrameReader,
  writeLegacyMessage,
  writeMessage,
  writeStreamChunk,
  writeStreamEnd,
  type IpcEnvelope,
  type OnMessageCallback,
  type StreamCallbacks,
} from "./ipc-framing.js";
