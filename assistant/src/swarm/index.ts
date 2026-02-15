export type {
  SwarmRole,
  SwarmTaskNode,
  SwarmPlan,
  SwarmTaskStatus,
  SwarmTaskResult,
  SwarmExecutionSummary,
} from './types.js';

export { VALID_SWARM_ROLES } from './types.js';

export type { SwarmLimits } from './limits.js';
export { resolveSwarmLimits, SWARM_HARD_LIMITS } from './limits.js';

export {
  validateAndNormalizePlan,
  SwarmPlanValidationError,
} from './plan-validator.js';

export type {
  WorkerProfile,
  ProfilePolicy,
  WorkerFailureReason,
  SwarmWorkerBackendResult,
  SwarmWorkerBackendInput,
  SwarmWorkerBackend,
} from './worker-backend.js';

export {
  roleToProfile,
  getProfilePolicy,
} from './worker-backend.js';
