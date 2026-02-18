export type { AutonomyTier, AutonomyConfig } from './types.js';
export { AUTONOMY_TIERS, DEFAULT_AUTONOMY_CONFIG } from './types.js';
export {
  getAutonomyConfig,
  setAutonomyConfig,
  getChannelDefault,
  setChannelDefault,
} from './autonomy-store.js';
export { resolveAutonomyTier } from './autonomy-resolver.js';
export type { WatcherDisposition } from './disposition-mapper.js';
export { mapTierToDisposition } from './disposition-mapper.js';
