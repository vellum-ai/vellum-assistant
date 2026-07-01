/**
 * Cryptographic voice invite code generation and hashing.
 *
 * Generates short numeric codes (default 6 digits) for voice-channel invite
 * redemption. The plaintext code is returned once at creation time and never
 * stored — only its SHA-256 hash is persisted.
 *
 * Thin aliases over the shared @vellumai/gateway-client invite contract so
 * gateway-computed hashes stay byte-for-byte compatible with daemon-minted
 * ones.
 */

export {
  generateInviteCode as generateVoiceCode,
  hashInviteCode as hashVoiceCode,
} from "@vellumai/gateway-client";
