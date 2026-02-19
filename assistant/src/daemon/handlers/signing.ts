import { log, pendingSignBundlePayload, pendingSigningIdentity, defineHandlers } from './shared.js';

export const signingHandlers = defineHandlers({
  sign_bundle_payload_response: (msg) => {
    const pending = pendingSignBundlePayload.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSignBundlePayload.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else if (msg.signature && msg.keyId && msg.publicKey) {
        pending.resolve({ signature: msg.signature, keyId: msg.keyId, publicKey: msg.publicKey });
      } else {
        pending.reject(new Error('Missing required fields in sign_bundle_payload_response'));
      }
    } else {
      log.warn({ requestId: msg.requestId }, 'Received sign_bundle_payload_response with no pending request');
    }
  },

  get_signing_identity_response: (msg) => {
    const pending = pendingSigningIdentity.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingSigningIdentity.delete(msg.requestId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else if (msg.keyId && msg.publicKey) {
        pending.resolve({ keyId: msg.keyId, publicKey: msg.publicKey });
      } else {
        pending.reject(new Error('Missing required fields in get_signing_identity_response'));
      }
    } else {
      log.warn({ requestId: msg.requestId }, 'Received get_signing_identity_response with no pending request');
    }
  },
});
