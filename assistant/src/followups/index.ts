export type { FollowUp, FollowUpCreateInput, FollowUpStatus } from './types.js';
export {
  createFollowUp,
  getFollowUp,
  listFollowUps,
  resolveFollowUp,
  resolveByThread,
  getOverdueFollowUps,
  markNudged,
} from './followup-store.js';
