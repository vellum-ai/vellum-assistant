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

/// Conversation streaming mode for an STT provider.
///
/// Describes whether and how the provider can participate in real-time
/// conversation streaming for chat message capture (chat composer and iOS
/// input bar). Clients use this to decide when to attempt streaming vs
/// falling back to batch transcription.
///
/// - `realtimeWs`: Provider offers a native WebSocket streaming endpoint
///   that accepts audio chunks and emits partial/final transcript events
///   with low latency (e.g. Deepgram live transcription).
/// - `incrementalBatch`: Provider does not offer true streaming but can be
///   polled with incremental audio batches to approximate streaming behaviour
///   (e.g. Google Gemini multimodal).
/// - `none`: Provider has no conversation streaming support; callers should
///   fall back to batch transcription.
public enum STTConversationStreamingMode: String, Decodable, Sendable {
    case realtimeWs = "realtime-ws"
    case incrementalBatch = "incremental-batch"
    case none

    /// Whether this mode supports any form of conversation streaming.
    public var supportsStreaming: Bool {
        self != .none
    }
}

/// Guide for obtaining API credentials from a provider.
///
/// Contains a short description of the steps, a URL to the provider's
/// key-management page, and a human-readable link label for display.
public struct STTCredentialsGuide: Decodable {
    /// Brief instructions for obtaining an API key (1-2 sentences).
    public let description: String
    /// URL to the provider's API key or console page.
    public let url: String
    /// Human-readable label for the link (e.g. "Open Deepgram Console").
    public let linkLabel: String
}

/// A single entry in the client-facing STT provider catalog.
///
/// This struct captures the subset of provider metadata that client apps
/// need for display and setup UX — identity, display strings, hints
/// about how the provider is configured, and conversation streaming
/// capability.
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
    /// Conversation streaming capability for this provider. Clients use
    /// this to decide whether to attempt WebSocket streaming for real-time
    /// transcription or fall back to batch STT.
    public let conversationStreamingMode: STTConversationStreamingMode
    /// Guide for obtaining API credentials from this provider.
    public let credentialsGuide: STTCredentialsGuide?
}

/// Top-level schema for `stt-provider-catalog.json`.
///
/// The JSON file lives at `meta/stt-provider-catalog.json` and is copied
/// into `Contents/Resources` by `build.sh`. It is the single source of
/// truth for client-facing STT provider metadata.
///
/// The daemon maintains its own canonical catalog in
/// `assistant/src/providers/speech-to-text/provider-catalog.ts`.
/// A CI parity test (`stt-catalog-parity.test.ts`) enforces that provider
/// IDs and credential-provider name mappings (`apiKeyProviderName`) remain
/// aligned between the JSON file and the daemon catalog.
public struct STTProviderRegistry: Decodable {
    public let version: Int
    public let providers: [STTProviderCatalogEntry]

    /// Look up a provider entry by its identifier.
    public func provider(withId id: String) -> STTProviderCatalogEntry? {
        providers.first { $0.id == id }
    }

    /// Returns the conversation streaming mode for the given provider, or
    /// `.none` if the provider is not in the catalog.
    public func conversationStreamingMode(forProvider id: String) -> STTConversationStreamingMode {
        provider(withId: id)?.conversationStreamingMode ?? .none
    }

    /// Whether the given provider supports any form of conversation streaming
    /// (real-time WebSocket or incremental batch).
    public func supportsConversationStreaming(provider id: String) -> Bool {
        conversationStreamingMode(forProvider: id).supportsStreaming
    }

    /// Whether the currently configured STT provider supports conversation
    /// streaming. Returns `false` if no provider is configured or the
    /// configured provider does not support streaming.
    ///
    /// Uses the `sttProvider` key from `UserDefaults` (synced from the
    /// assistant's `client_settings_update`).
    public static var isStreamingAvailable: Bool {
        guard let providerId = UserDefaults.standard.string(forKey: "sttProvider"),
              !providerId.isEmpty else {
            return false
        }
        let registry = loadSTTProviderRegistry()
        return registry.supportsConversationStreaming(provider: providerId)
    }

    /// Whether the assistant has an LLM-based STT provider configured
    /// (e.g. Deepgram, OpenAI Whisper).
    ///
    /// When `true`, the app can use the assistant's STT service for
    /// transcription and native `SFSpeechRecognizer` permission is not
    /// required. The value is derived from the `sttProvider` key in
    /// `UserDefaults`, which is only set when the assistant syncs its
    /// configuration via `client_settings_update` (see `SettingsStore`).
    ///
    /// Note: credentials are managed by the assistant (daemon-side), not
    /// stored in the client's `APIKeyManager`. The `sttProvider` key is
    /// only populated when the assistant broadcasts a valid config, so
    /// its presence reliably indicates the service is operational.
    public static var isServiceConfigured: Bool {
        guard let value = UserDefaults.standard.string(forKey: "sttProvider") else {
            return false
        }
        return !value.isEmpty
    }
}

// MARK: - Fallback

/// Hard-coded fallback registry used when the bundled JSON is missing or
/// corrupt. Keeps client startup resilient — the app can always show at
/// least the current set of providers.
///
/// **Parity requirement**: The provider IDs and `apiKeyProviderName`
/// mappings below MUST remain in sync with `meta/stt-provider-catalog.json`
/// (the single source of truth for client-facing metadata) and with the
/// daemon-side catalog in
/// `assistant/src/providers/speech-to-text/provider-catalog.ts`.
/// A CI parity test (`stt-catalog-parity.test.ts`) enforces alignment
/// between the daemon catalog and the JSON file. If you add or rename a
/// provider here, update both the JSON catalog and the daemon catalog to
/// keep all three in lockstep.
private let fallbackRegistry = STTProviderRegistry(
    version: 0,
    providers: [
        STTProviderCatalogEntry(
            id: "deepgram",
            displayName: "Deepgram",
            subtitle: "Fast, real-time speech-to-text with streaming support. Requires a Deepgram API key.",
            setupMode: .apiKey,
            setupHint: "Enter your Deepgram API key to enable speech-to-text.",
            apiKeyProviderName: "deepgram",
            conversationStreamingMode: .realtimeWs,
            credentialsGuide: STTCredentialsGuide(
                description: "Sign in to the Deepgram console, navigate to API Keys, and create a new key.",
                url: "https://console.deepgram.com/",
                linkLabel: "Open Deepgram Console"
            )
        ),
        STTProviderCatalogEntry(
            id: "google-gemini",
            displayName: "Google Gemini",
            subtitle: "Multimodal speech-to-text powered by Google Gemini. Requires a Gemini API key.",
            setupMode: .apiKey,
            setupHint: "Enter your Gemini API key to enable Google Gemini transcription.",
            apiKeyProviderName: "gemini",
            conversationStreamingMode: .realtimeWs,
            credentialsGuide: STTCredentialsGuide(
                description: "Visit Google AI Studio, sign in with your Google account, and create an API key.",
                url: "https://aistudio.google.com/apikey",
                linkLabel: "Open Google AI Studio"
            )
        ),
        STTProviderCatalogEntry(
            id: "openai-whisper",
            displayName: "OpenAI Whisper",
            subtitle: "High-accuracy speech-to-text powered by OpenAI Whisper. Requires an OpenAI API key.",
            setupMode: .apiKey,
            setupHint: "Enter your OpenAI API key to enable Whisper transcription.",
            apiKeyProviderName: "openai",
            conversationStreamingMode: .incrementalBatch,
            credentialsGuide: STTCredentialsGuide(
                description: "Log in to the OpenAI platform, go to API Keys, and generate a new secret key.",
                url: "https://platform.openai.com/api-keys",
                linkLabel: "Open OpenAI Platform"
            )
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
