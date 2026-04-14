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
/// need for display and setup UX — identity, display strings, and hints
/// about how the provider is configured.
public struct TTSProviderCatalogEntry: Decodable {
    /// Unique provider identifier (e.g. `"elevenlabs"`, `"fish-audio"`).
    public let id: String
    /// Human-readable name for display in settings UI.
    public let displayName: String
    /// Short description shown below the provider selector.
    public let subtitle: String
    /// How the provider's credentials are configured.
    public let setupMode: TTSProviderSetupMode
    /// Brief help text guiding the user through setup.
    public let setupHint: String
    /// Guide for obtaining API credentials from this provider.
    public let credentialsGuide: TTSCredentialsGuide?
}

/// Top-level schema for `tts-provider-catalog.json`.
///
/// The JSON file lives at `meta/tts-provider-catalog.json` and is copied
/// into `Contents/Resources` by `build.sh`. It is the single source of
/// truth for client-facing TTS provider metadata.
public struct TTSProviderRegistry: Decodable {
    public let version: Int
    public let providers: [TTSProviderCatalogEntry]

    /// Look up a provider entry by its identifier.
    public func provider(withId id: String) -> TTSProviderCatalogEntry? {
        providers.first { $0.id == id }
    }
}

// MARK: - Fallback

/// Hard-coded fallback registry used when the bundled JSON is missing or
/// corrupt. Keeps client startup resilient — the app can always show at
/// least the current set of providers.
private let fallbackRegistry = TTSProviderRegistry(
    version: 0,
    providers: [
        TTSProviderCatalogEntry(
            id: "elevenlabs",
            displayName: "ElevenLabs",
            subtitle: "High-quality voice synthesis for conversations and read-aloud. Requires an ElevenLabs API key.",
            setupMode: .apiKey,
            setupHint: "Enter your ElevenLabs API key to get started.",
            credentialsGuide: TTSCredentialsGuide(
                description: "Sign in to ElevenLabs, go to your Profile, and copy your API key.",
                url: "https://elevenlabs.io/app/settings/api-keys",
                linkLabel: "Open ElevenLabs API Keys"
            )
        ),
        TTSProviderCatalogEntry(
            id: "fish-audio",
            displayName: "Fish Audio",
            subtitle: "Natural-sounding voice synthesis with custom voice cloning. Requires a Fish Audio API key and voice reference ID.",
            setupMode: .cli,
            setupHint: "Run the setup commands in your terminal to configure Fish Audio.",
            credentialsGuide: TTSCredentialsGuide(
                description: "Sign in to Fish Audio, navigate to API Keys in your dashboard, and create a new key.",
                url: "https://fish.audio/api-keys/",
                linkLabel: "Open Fish Audio API Keys"
            )
        ),
    ]
)

// MARK: - Loader

/// Cached registry loaded once per process lifetime.
/// The bundled `tts-provider-catalog.json` is immutable at runtime (baked
/// into the app at build time), so reading it more than once is unnecessary
/// I/O. Swift guarantees thread-safe lazy initialization of static
/// properties.
private let _cachedTTSProviderRegistry: TTSProviderRegistry = {
    guard let url = Bundle.main.url(forResource: "tts-provider-catalog", withExtension: "json") else {
        log.warning("tts-provider-catalog.json not found in bundle — using fallback registry")
        return fallbackRegistry
    }
    guard let data = try? Data(contentsOf: url) else {
        log.error("Failed to read tts-provider-catalog.json from bundle")
        return fallbackRegistry
    }
    do {
        let registry = try JSONDecoder().decode(TTSProviderRegistry.self, from: data)
        guard !registry.providers.isEmpty else {
            log.error("tts-provider-catalog.json decoded but contains no providers — using fallback registry")
            return fallbackRegistry
        }
        return registry
    } catch {
        log.error("Failed to decode tts-provider-catalog.json: \(error.localizedDescription, privacy: .public)")
        return fallbackRegistry
    }
}()

/// Load the TTS provider registry from the app bundle's Resources.
///
/// Returns a cached result after the first call — the bundled JSON never
/// changes at runtime so re-reading from disk is unnecessary.
///
/// If the JSON file is missing, unreadable, or corrupt the function
/// returns a hard-coded fallback containing the current provider set so
/// that client startup is never blocked.
public func loadTTSProviderRegistry() -> TTSProviderRegistry {
    _cachedTTSProviderRegistry
}
