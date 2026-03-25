export {
  type A2AEnvelope,
  type A2AMessageEnvelope,
  type A2APairingAccepted,
  type A2APairingFinalize,
  type A2APairingRequest,
  A2AValidationError,
  parseA2AEnvelope,
} from "./message-contract.js";

export {
  type PairingDirection,
  type PairingRequest,
  type PairingStatus,
  createPairingRequest,
  findPairingByInviteCode,
  findPairingByRemoteAssistant,
  PAIRING_REQUEST_TTL_MS,
  updatePairingStatus,
} from "./pairing-store.js";

export {
  type InitiatePairingResult,
  completePairingApproval,
  handleInboundPairingRequest,
  handlePairingAccepted,
  handlePairingFinalize,
  initiatePairing,
} from "./pairing.js";
