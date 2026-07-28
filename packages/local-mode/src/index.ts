/**
 * @vellumai/local-mode — shared host library for serving the local-assistant
 * surface (lockfile reads, guardian-token issuance, gateway proxying, and the
 * hatch/retire/wake lifecycle ops) over a loopback HTTP boundary. Consumed by the
 * CLI `client` server and the web app's dev-server middleware so the local
 * endpoint behaviour is defined exactly once instead of one host reaching into
 * another's source tree. Depends only on `@vellumai/environments`.
 */
export {
  stripSensitiveFields,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  resolveDevCliInvocation,
} from "./util";
export type { CliInvocation } from "./util";
export {
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
  resolveConfigDir,
  guardianTokenPath,
} from "./config";
export type { LocalEndpointConfig } from "./config";
export {
  defaultEnvironmentFilePath,
  readDefaultEnvironment,
  resolveEnvironmentName,
} from "./environment";
export {
  getLockfileData,
  upsertLockfileAssistant,
  replacePlatformAssistants,
  isActiveAssistant,
} from "./lockfile";
export type { LockfileResult, WriteResult } from "./lockfile";
export { parseLockfile } from "./lockfile-contract";
export type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LockfileWriteResult,
} from "./lockfile-contract";
export { runHatch } from "./hatch";
export type { HatchResult } from "./hatch";
export { runRetire } from "./retire";
export type { RetireOptions, RetireResult } from "./retire";
export { runSleep } from "./sleep";
export type { SleepResult } from "./sleep";
export { runWake } from "./wake";
export type { WakeOptions, WakeResult } from "./wake";
export { runUpgrade, isValidReleaseVersion } from "./upgrade";
export type { UpgradeOptions, UpgradeResult } from "./upgrade";
export { getLocalAssistantStatus } from "./status";
export type {
  LocalAssistantRuntimeState,
  LocalAssistantStatusResult,
} from "./status";
export { getGuardianAccessToken } from "./guardian-token";
export type { TokenResult } from "./guardian-token";
export {
  parseGatewayUrl,
  readAllowedGatewayPorts,
  resolveGatewayProxyTarget,
} from "./gateway-proxy";
export type {
  GatewayTarget,
  GatewayParseResult,
  GatewayProxyDecision,
} from "./gateway-proxy";
