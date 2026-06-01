/**
 * @vellumai/local-mode — shared host library for serving the local-assistant
 * surface (lockfile reads, guardian-token issuance, gateway proxying, and the
 * hatch/retire lifecycle ops) over a loopback HTTP boundary. Consumed by the
 * CLI `client` server and the web app's dev-server middleware so the local
 * endpoint behaviour is defined exactly once instead of one host reaching into
 * another's source tree. Depends only on `@vellumai/environments`.
 */
export {
  stripSensitiveFields,
  isLoopbackAddr,
  resolveDevCliInvocation,
} from "./util";
export type { CliInvocation } from "./util";
export { resolveLocalConfigFromEnv, resolveLockfilePaths, resolveConfigDir } from "./config";
export type { LocalEndpointConfig } from "./config";
export { getLockfileData, upsertLockfileAssistant, replacePlatformAssistants } from "./lockfile";
export type { LockfileResult, WriteResult } from "./lockfile";
export { runHatch } from "./hatch";
export type { HatchResult } from "./hatch";
export { runRetire } from "./retire";
export type { RetireResult } from "./retire";
export { getGuardianAccessToken } from "./guardian-token";
export type { TokenResult } from "./guardian-token";
export { parseGatewayUrl, readAllowedGatewayPorts } from "./gateway-proxy";
export type { GatewayTarget, GatewayParseResult } from "./gateway-proxy";
