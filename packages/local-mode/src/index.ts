/**
 * @vellumai/local-mode — shared host library for serving the local-assistant
 * surface (lockfile reads, guardian-token issuance, gateway proxying, and the
 * hatch/retire/wake lifecycle ops) over a loopback HTTP boundary. Consumed by the
 * CLI `client` server and the web app's dev-server middleware so the local
 * endpoint behaviour is defined exactly once instead of one host reaching into
 * another's source tree. `@vellumai/environments` is its only workspace
 * dependency.
 */
export {
  stripSensitiveFields,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  hasSameOriginCredentialProof,
  resolveDevCliInvocation,
} from "./util";
export type { CliInvocation } from "./util";
export {
  resolveLocalConfigFromEnv,
  resolveLockfilePaths,
  resolveConfigDir,
  resolveConfigDirPaths,
  resolveRuntimeDir,
  resolveLogDir,
  resolveAssistantsDir,
  resolveInstanceDir,
  guardianTokenPath,
} from "./config";
export type { LocalEndpointConfig } from "./config";
export type { LocalPathOptions } from "./paths";
export {
  defaultEnvironmentFilePath,
  defaultEnvironmentFilePaths,
  readDefaultEnvironment,
  resolveEnvironmentName,
} from "./environment";
export {
  getLockfileData,
  renameLockfileAssistantIfPresent,
  upsertLockfileAssistant,
  upsertRendererLockfileAssistant,
  replacePlatformAssistants,
  isActiveAssistant,
  isPairedLockfileEntry,
} from "./lockfile";
export type { LockfileResult, WriteResult } from "./lockfile";
export { withLockfileLock } from "./lockfile-lock";
export type { LockfileLockResult } from "./lockfile-lock";
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
export { unpairAssistant } from "./unpair";
export { decodePairBundle, pairAssistant, connectImport } from "./pair";
export { runSleep } from "./sleep";
export type { SleepResult } from "./sleep";
export { runWake } from "./wake";
export type { WakeOptions, WakeResult } from "./wake";
export { runDevicesList, runDevicesRevoke } from "./devices";
export type {
  DeviceRecord,
  DevicesListResult,
  DevicesRevokeResult,
} from "./devices";
export { runUpgrade, isValidReleaseVersion } from "./upgrade";
export type { UpgradeOptions, UpgradeResult } from "./upgrade";
export { getLocalAssistantStatus } from "./status";
export type {
  LocalAssistantRuntimeState,
  LocalAssistantStatusResult,
} from "./status";
export {
  getGuardianAccessToken,
  getPairedGuardianAccessToken,
  isConfidentialRefreshUrl,
  formatGuardianRefreshCliFailure,
  parseGuardianRefreshCliFailure,
  PAIRED_GUARDIAN_TOKEN_HOST_ONLY_ERROR,
  PAIRED_GUARDIAN_TARGET_MISMATCH_ERROR,
  GUARDIAN_REFRESH_ERROR_PREFIX,
  saveGuardianToken,
} from "./guardian-token";
export type {
  TokenResult,
  GuardianTokenData,
  GuardianTokenOptions,
} from "./guardian-token";
export {
  authorizePairedForwardHeaders,
  parseGatewayUrl,
  readAllowedGatewayPorts,
  resolveGatewayProxyTarget,
  parsePairedGatewayUrl,
  pairedGatewayTargetsFromLockfile,
  readPairedGatewayTargets,
  resolvePairedGatewayProxyTarget,
  sanitizePairedForwardHeaders,
} from "./gateway-proxy";
export type {
  GatewayTarget,
  GatewayParseResult,
  GatewayProxyDecision,
  PairedForwardAuthorizationResult,
  PairedGuardianTokenProvider,
} from "./gateway-proxy";
