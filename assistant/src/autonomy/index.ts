export { resolveAutonomyTier } from './autonomy-resolver.js';
export {
  getAutonomyConfig,
  getChannelDefault,
  setAutonomyConfig,
  setChannelDefault,
} from './autonomy-store.js';
export type { WatcherDisposition } from './disposition-mapper.js';
export { mapTierToDisposition } from './disposition-mapper.js';
export type { AutonomyConfig,AutonomyTier } from './types.js';
export { AUTONOMY_TIERS, DEFAULT_AUTONOMY_CONFIG } from './types.js';
