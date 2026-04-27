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
public enum STTProviderSetupMode: String, Decodable, Sendable {
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
public struct STTCredentialsGuide: Decodable, Sendable {
    /// Brief instructions for obtaining an API key (1-2 sentences).
    public let description: String
    /// URL to the provider's API key or console page.
    public let url: String
    /// Human-readable label for the link (e.g. "Open Deepgram Console").
    public let linkLabel: String
}

/// A single entry in the STT provider catalog.
///
/// This struct captures the subset of provider metadata that client apps
/// need for display and setup UX — identity, display strings, hints
/// about how the provider is configured, and conversation streaming
/// capability.
public struct STTProviderCatalogEntry: Decodable, Sendable {
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
    /// name in the daemon's secret catalog.
    public let apiKeyProviderName: String
    /// Conversation streaming capability for this provider.
    public let conversationStreamingMode: STTConversationStreamingMode
    /// Guide for obtaining API credentials from this provider.
    public let credentialsGuide: STTCredentialsGuide?
}

/// STT provider registry loaded from the assistant API.
public struct STTProviderRegistry: Decodable, Sendable {
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
    /// required.
    public static var isServiceConfigured: Bool {
        guard let value = UserDefaults.standard.string(forKey: "sttProvider") else {
            return false
        }
        return !value.isEmpty
    }
}

// MARK: - Loader

/// Lock-protected cached registry, populated lazily by
/// `refreshSTTProviderRegistry()`.
private let cachedSTTProviderRegistry = OSAllocatedUnfairLock<STTProviderRegistry>(
    initialState: STTProviderRegistry(providers: [])
)

/// Returns the cached STT provider registry.
///
/// The registry starts empty and is populated on first access to the
/// STT settings panel via `refreshSTTProviderRegistry()`.  Thread-safe.
public func loadSTTProviderRegistry() -> STTProviderRegistry {
    cachedSTTProviderRegistry.withLock { $0 }
}

/// Fetches the STT provider catalog from the assistant API and caches it.
///
/// Called lazily when the STT settings panel first appears. Failures are
/// logged but non-fatal — the registry stays empty until a successful fetch.
public func refreshSTTProviderRegistry() async {
    do {
        let (registry, _): (STTProviderRegistry?, GatewayHTTPClient.Response) =
            try await GatewayHTTPClient.get(path: "assistants/{assistantId}/stt/providers")
        if let registry, !registry.providers.isEmpty {
            cachedSTTProviderRegistry.withLock { $0 = registry }
            log.info("Loaded \(registry.providers.count) STT providers from API")
        } else {
            log.warning("STT providers API returned empty or nil response")
        }
    } catch {
        log.error("Failed to fetch STT providers: \(error.localizedDescription, privacy: .public)")
    }
}
