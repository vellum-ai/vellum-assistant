import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "TTSProviderRegistry")

// MARK: - Types

/// How the provider's credentials are configured by the user.
///
/// - `apiKey`:  The client can collect and store the key directly (e.g. via
///              a text field in Settings).
/// - `cli`:    Setup requires running CLI commands — the client should show
///              instructions rather than an inline key field.
public enum TTSProviderSetupMode: String, Decodable {
    case apiKey = "api-key"
    case cli
}

/// How the provider's API key is stored and looked up.
///
/// - `credential`: Stored as a service/field pair via
///   `APIKeyManager.setCredential(_:service:field:)`. The `credentialNamespace`
///   field on the catalog entry supplies the service name; the field is always
///   `"api_key"`.
/// - `apiKey`: Stored as a flat provider key via
///   `APIKeyManager.setKey(_:for:)`. The `apiKeyProviderName` field on the
///   catalog entry supplies the key name.
public enum TTSCredentialMode: String, Decodable {
    case credential
    case apiKey = "api-key"
}

/// Guide for obtaining API credentials from a TTS provider.
///
/// Contains a short description of the steps, a URL to the provider's
/// key-management page, and a human-readable link label for display.
public struct TTSCredentialsGuide: Decodable {
    /// Brief instructions for obtaining an API key (1-2 sentences).
    public let description: String
    /// URL to the provider's API key or console page.
    public let url: String
    /// Human-readable label for the link (e.g. "Open ElevenLabs Dashboard").
    public let linkLabel: String
}

/// A single entry in the client-facing TTS provider catalog.
///
/// This struct captures the subset of provider metadata that client apps
/// need for display and setup UX — identity, display strings, hints
/// about how the provider is configured, and credential storage semantics.
public struct TTSProviderCatalogEntry: Decodable {
    /// Unique provider identifier (e.g. `"elevenlabs"`, `"fish-audio"`, `"deepgram"`).
    public let id: String
    /// Human-readable name for display in settings UI.
    public let displayName: String
    /// Short description shown below the provider selector.
    public let subtitle: String
    /// How the provider's credentials are configured.
    public let setupMode: TTSProviderSetupMode
    /// Brief help text guiding the user through setup.
    public let setupHint: String
    /// How the provider's API key is stored — as a credential (service/field
    /// pair) or as a flat provider key. Defaults to `.credential` for
    /// backwards compatibility with existing providers.
    public let credentialMode: TTSCredentialMode
    /// The credential service name used when `credentialMode` is `.credential`.
    /// For example, `"elevenlabs"` maps to
    /// `APIKeyManager.getCredential(service: "elevenlabs", field: "api_key")`.
    /// `nil` when the provider uses api-key mode.
    public let credentialNamespace: String?
    /// The key provider name used when `credentialMode` is `.apiKey`.
    /// For example, `"deepgram"` maps to `APIKeyManager.getKey(for: "deepgram")`.
    /// When a TTS provider shares an API key with another service (e.g.
    /// Deepgram TTS shares the `deepgram` key with Deepgram STT), this
    /// field names the shared credential.
    /// `nil` when the provider uses credential mode.
    public let apiKeyProviderName: String?
    /// Whether this provider supports user-specified voice selection
    /// (e.g. a Voice ID or Reference ID field). Providers that use a
    /// built-in default model and do not expose voice selection should
    /// set this to `false`. Defaults to `false` when omitted from the
    /// API response.
    public let supportsVoiceSelection: Bool
    /// Guide for obtaining API credentials from this provider.
    public let credentialsGuide: TTSCredentialsGuide?

    // Custom decoder so that `supportsVoiceSelection` defaults to `false`
    // when absent from the API response (backward compatibility).
    private enum CodingKeys: String, CodingKey {
        case id, displayName, subtitle, setupMode, setupHint
        case credentialMode, credentialNamespace, apiKeyProviderName
        case supportsVoiceSelection, credentialsGuide
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decode(String.self, forKey: .displayName)
        subtitle = try c.decode(String.self, forKey: .subtitle)
        setupMode = try c.decode(TTSProviderSetupMode.self, forKey: .setupMode)
        setupHint = try c.decode(String.self, forKey: .setupHint)
        credentialMode = try c.decode(TTSCredentialMode.self, forKey: .credentialMode)
        credentialNamespace = try c.decodeIfPresent(String.self, forKey: .credentialNamespace)
        apiKeyProviderName = try c.decodeIfPresent(String.self, forKey: .apiKeyProviderName)
        supportsVoiceSelection = try c.decodeIfPresent(Bool.self, forKey: .supportsVoiceSelection) ?? false
        credentialsGuide = try c.decodeIfPresent(TTSCredentialsGuide.self, forKey: .credentialsGuide)
    }

    /// Memberwise initializer for programmatic construction (e.g. tests).
    public init(
        id: String,
        displayName: String,
        subtitle: String,
        setupMode: TTSProviderSetupMode,
        setupHint: String,
        credentialMode: TTSCredentialMode,
        credentialNamespace: String?,
        apiKeyProviderName: String?,
        supportsVoiceSelection: Bool = false,
        credentialsGuide: TTSCredentialsGuide?
    ) {
        self.id = id
        self.displayName = displayName
        self.subtitle = subtitle
        self.setupMode = setupMode
        self.setupHint = setupHint
        self.credentialMode = credentialMode
        self.credentialNamespace = credentialNamespace
        self.apiKeyProviderName = apiKeyProviderName
        self.supportsVoiceSelection = supportsVoiceSelection
        self.credentialsGuide = credentialsGuide
    }
}

/// TTS provider registry loaded from the assistant API.
public struct TTSProviderRegistry: Decodable {
    public let providers: [TTSProviderCatalogEntry]

    /// Look up a provider entry by its identifier.
    public func provider(withId id: String) -> TTSProviderCatalogEntry? {
        providers.first { $0.id == id }
    }
}

// MARK: - Loader

/// Lock-protected cached registry, populated lazily by
/// `refreshTTSProviderRegistry()`.
private let _registryLock = NSLock()
private var _cachedTTSProviderRegistry = TTSProviderRegistry(providers: [])

/// Returns the cached TTS provider registry.
///
/// The registry starts empty and is populated on first access to the
/// TTS settings panel via `refreshTTSProviderRegistry()`.  Thread-safe.
public func loadTTSProviderRegistry() -> TTSProviderRegistry {
    _registryLock.lock()
    defer { _registryLock.unlock() }
    return _cachedTTSProviderRegistry
}

/// Replaces the cached TTS provider registry. **Test-only** — call this
/// in `setUp()` to provide a known registry without hitting the network.
public func _seedTTSProviderRegistryForTesting(_ registry: TTSProviderRegistry) {
    _registryLock.lock()
    _cachedTTSProviderRegistry = registry
    _registryLock.unlock()
}

/// Fetches the TTS provider catalog from the assistant API and caches it.
///
/// Called lazily when the TTS settings panel first appears. Failures are
/// logged but non-fatal — the registry stays empty until a successful fetch.
public func refreshTTSProviderRegistry() async {
    do {
        let (registry, _): (TTSProviderRegistry?, GatewayHTTPClient.Response) =
            try await GatewayHTTPClient.get(path: "assistants/{assistantId}/tts/providers")
        if let registry, !registry.providers.isEmpty {
            _registryLock.lock()
            _cachedTTSProviderRegistry = registry
            _registryLock.unlock()
            log.info("Loaded \(registry.providers.count) TTS providers from API")
        } else {
            log.warning("TTS providers API returned empty or nil response")
        }
    } catch {
        log.error("Failed to fetch TTS providers: \(error.localizedDescription, privacy: .public)")
    }
}
