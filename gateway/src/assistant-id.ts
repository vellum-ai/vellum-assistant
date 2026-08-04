/**
 * The daemon's internal assistant scope identifier.
 *
 * A gateway process fronts exactly one daemon, reachable at a single
 * `assistantRuntimeBaseUrl`. Nothing on the inbound message path carries an
 * assistant id to the runtime — `RuntimeInboundPayload` has no such field — so
 * this is the scope label the gateway stamps on the traffic it forwards, not a
 * selector that picks between backends.
 */
export const LOCAL_ASSISTANT_ID = "self";
