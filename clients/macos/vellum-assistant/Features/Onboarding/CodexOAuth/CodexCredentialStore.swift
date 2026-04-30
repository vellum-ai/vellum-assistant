import Foundation
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "CodexCredentialStore"
)

/// Persistence shim for OpenAI Codex OAuth credentials over `APIKeyManager`.
/// Stores a single base64-encoded JSON blob at the credential key
/// `openai_codex_oauth:blob`. Daemon-side reader at
/// `assistant/src/providers/openai/codex-credentials.ts` consumes the same
/// path via `credentialKey("openai_codex_oauth", "blob")`.
enum CodexCredentialStore {
    static let service = "openai_codex_oauth"
    static let field = "blob"

    static func save(_ creds: CodexCredentials) {
        guard let raw = encode(creds) else {
            log.error("Failed to encode Codex credentials")
            return
        }
        APIKeyManager.setCredential(raw, service: service, field: field)
    }

    static func load() -> CodexCredentials? {
        guard let raw = APIKeyManager.getCredential(service: service, field: field) else {
            return nil
        }
        return decode(raw)
    }

    static func clear() {
        APIKeyManager.deleteCredential(service: service, field: field)
    }

    /// Push the locally-stored blob to the daemon's secret store. Used by
    /// `HatchingStepView` post-hatch to resolve the daemon-startup race that
    /// also affects API keys (cf. `saveAndHatch` in `APIKeyEntryStepView`).
    static func pushToDaemonIfPresent() async {
        guard let raw = APIKeyManager.getCredential(service: service, field: field) else {
            return
        }
        _ = await APIKeyManager.setCredential(raw, service: service, field: field)
    }

    // MARK: - Encoding

    private static func encode(_ creds: CodexCredentials) -> String? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        guard let data = try? encoder.encode(creds) else { return nil }
        return data.base64EncodedString()
    }

    private static func decode(_ raw: String) -> CodexCredentials? {
        guard let data = Data(base64Encoded: raw) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try? decoder.decode(CodexCredentials.self, from: data)
    }
}
