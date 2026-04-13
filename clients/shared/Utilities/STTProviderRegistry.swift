import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "STTProviderRegistry")

// MARK: - Types

/// How the provider's credentials are configured by the user.
///
/// - `apiKey`:  The client can collect and store the key directly (e.g. via
///              a text field in Settings).
/// - `cli`:    Setup requires running CLI commands — the client should show
///              instructions rather than an inline key field.
public enum STTProviderSetupMode: String, Decodable {
    case apiKey = "api-key"
    case cli
}

/// A single entry in the client-facing STT provider catalog.
///
/// This struct captures the subset of provider metadata that client apps
/// need for display and setup UX — identity, display strings, and hints
/// about how the provider is configured.
public struct STTProviderCatalogEntry: Decodable {
    /// Unique provider identifier (e.g. `"openai-whisper"`, `"deepgram"`).
    public let id: String
    /// Human-readable name for display in settings UI.
    public let displayName: String
    /// Short description shown below the provider selector.
    public let subtitle: String
    /// How the provider's credentials are configured.
    public let setupMode: STTProviderSetupMode
    /// Brief help text guiding the user through setup.
    public let setupHint: String
    /// The credential provider name used when persisting the API key via
    /// `APIKeyManager`. Maps the STT provider id to the `api_key` secret
    /// name in the daemon's secret catalog. For example, `openai-whisper`
    /// shares the `openai` API key while `deepgram` uses `deepgram`.
    public let apiKeyProviderName: String
}

/// Top-level schema for `stt-provider-catalog.json`.
///
/// The JSON file lives at `meta/stt-provider-catalog.json` and is copied
/// into `Contents/Resources` by `build.sh`. It is the single source of
/// truth for client-facing STT provider metadata.
public struct STTProviderRegistry: Decodable {
    public let version: Int
    public let providers: [STTProviderCatalogEntry]

    /// Look up a provider entry by its identifier.
    public func provider(withId id: String) -> STTProviderCatalogEntry? {
        providers.first { $0.id == id }
    }

    /// Whether the assistant has an LLM-based STT provider configured
    /// **and credentialed** (e.g. Deepgram, OpenAI Whisper).
    ///
    /// When `true`, the app can use the assistant's STT service for
    /// transcription and native `SFSpeechRecognizer` permission is not
    /// required. The value is derived from the `sttProvider` key in
    /// `UserDefaults` (synced via `client_settings_update`) combined
    /// with a credential check — a provider without an API key cannot
    /// perform transcription.
    public static var isServiceConfigured: Bool {
        guard let providerId = UserDefaults.standard.string(forKey: "sttProvider"),
              !providerId.isEmpty else {
            return false
        }
        // Resolve the keychain/UserDefaults key name for this provider's API key.
        let keyProvider = loadSTTProviderRegistry()
            .provider(withId: providerId)?
            .apiKeyProviderName ?? providerId
        // Check that a credential actually exists — provider without a key can't transcribe.
        guard let key = APIKeyManager.shared.getAPIKey(provider: keyProvider),
              !key.isEmpty else {
            return false
        }
        return true
    }
}

// MARK: - Fallback

/// Hard-coded fallback registry used when the bundled JSON is missing or
/// corrupt. Keeps client startup resilient — the app can always show at
/// least the current set of providers.
private let fallbackRegistry = STTProviderRegistry(
    version: 0,
    providers: [
        STTProviderCatalogEntry(
            id: "openai-whisper",
            displayName: "OpenAI Whisper",
            subtitle: "High-accuracy speech-to-text powered by OpenAI Whisper. Requires an OpenAI API key.",
            setupMode: .apiKey,
            setupHint: "Enter your OpenAI API key to enable Whisper transcription.",
            apiKeyProviderName: "openai"
        ),
        STTProviderCatalogEntry(
            id: "deepgram",
            displayName: "Deepgram",
            subtitle: "Fast, real-time speech-to-text with streaming support. Requires a Deepgram API key.",
            setupMode: .apiKey,
            setupHint: "Enter your Deepgram API key to enable speech-to-text.",
            apiKeyProviderName: "deepgram"
        ),
    ]
)

// MARK: - Loader

/// Cached registry loaded once per process lifetime.
/// The bundled `stt-provider-catalog.json` is immutable at runtime (baked
/// into the app at build time), so reading it more than once is unnecessary
/// I/O. Swift guarantees thread-safe lazy initialization of static
/// properties.
private let _cachedSTTProviderRegistry: STTProviderRegistry = {
    guard let url = Bundle.main.url(forResource: "stt-provider-catalog", withExtension: "json") else {
        log.warning("stt-provider-catalog.json not found in bundle — using fallback registry")
        return fallbackRegistry
    }
    guard let data = try? Data(contentsOf: url) else {
        log.error("Failed to read stt-provider-catalog.json from bundle")
        return fallbackRegistry
    }
    do {
        let registry = try JSONDecoder().decode(STTProviderRegistry.self, from: data)
        guard !registry.providers.isEmpty else {
            log.error("stt-provider-catalog.json decoded but contains no providers — using fallback registry")
            return fallbackRegistry
        }
        return registry
    } catch {
        log.error("Failed to decode stt-provider-catalog.json: \(error.localizedDescription, privacy: .public)")
        return fallbackRegistry
    }
}()

/// Load the STT provider registry from the app bundle's Resources.
///
/// Returns a cached result after the first call — the bundled JSON never
/// changes at runtime so re-reading from disk is unnecessary.
///
/// If the JSON file is missing, unreadable, or corrupt the function
/// returns a hard-coded fallback containing the current provider set so
/// that client startup is never blocked.
public func loadSTTProviderRegistry() -> STTProviderRegistry {
    _cachedSTTProviderRegistry
}
