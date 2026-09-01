/**
 * Daemon door for the shared `<no_response/>` sentinel convention. The
 * definitions live in `@vellumai/service-contracts/no-response` so the
 * daemon, gateway, and clients parse identically; this module exists so
 * daemon-internal imports keep one stable path.
 */
export {
  containsNoResponseMarker,
  hasDeliverableAssistantText,
  isNoResponseOnlyText,
  isPotentialNoResponsePrefix,
  NO_RESPONSE_INLINE_RE,
  stripNoResponseMarkers,
} from "@vellumai/service-contracts/no-response";
