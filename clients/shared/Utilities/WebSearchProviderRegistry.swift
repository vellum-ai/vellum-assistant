import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "WebSearchProviderRegistry")

// MARK: - Types

/// How a web-search provider is configured.
///
/// - `managed`: Native to the inference provider (e.g. Anthropic's
///              `web_search_20250305` tool). No standalone API key.
/// - `byok`: Bring-your-own-key — user supplies the provider's API key
///           directly.
public enum WebSearchProviderKind: String, Decodable {
    case managed
    case byok
}

/// A single entry in the client-facing web-search provider catalog.
///
/// Captures the subset of provider metadata that client apps need to
/// render the web-search settings UI and explain the provider in
/// marketing/privacy copy.
public struct WebSearchProviderEntry: Decodable {
    /// Unique provider identifier (e.g. `"perplexity"`, `"brave"`).
    public let id: String
    /// Short display name for use in pickers (e.g. `"Brave"`).
    public let displayName: String
    /// Optional longer display name preferred in marketing prose
    /// (e.g. `"Brave Search"`). Falls back to `displayName` when nil.
    public let displayNameLong: String?
    /// How the provider's credentials are configured.
    public let kind: WebSearchProviderKind
    /// Example placeholder shown to hint at the API-key format
    /// (e.g. `"pplx-..."`). `nil` for `managed` providers.
    public let apiKeyPrefix: String?
    /// Name of the environment variable the provider conventionally reads
    /// its API key from (e.g. `PERPLEXITY_API_KEY`). `nil` for `managed`.
    public let envVar: String?
    /// Stable identifier used as the secret store's `provider` field when
    /// reading/writing the API key (e.g. `"perplexity"`). `nil` for
    /// `managed` providers.
    public let secretKey: String?
    /// Ordering used by the daemon's BYOK fallback chain. Lower numbers
    /// are tried first. `nil` for `managed` providers (no fallback role).
    public let fallbackOrder: Int?
    /// URL to the provider's privacy policy, surfaced in the marketing
    /// docs vendor list. `nil` for `managed` providers.
    public let privacyPolicyUrl: String?

    public init(
        id: String,
        displayName: String,
        displayNameLong: String? = nil,
        kind: WebSearchProviderKind,
        apiKeyPrefix: String? = nil,
        envVar: String? = nil,
        secretKey: String? = nil,
        fallbackOrder: Int? = nil,
        privacyPolicyUrl: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.displayNameLong = displayNameLong
        self.kind = kind
        self.apiKeyPrefix = apiKeyPrefix
        self.envVar = envVar
        self.secretKey = secretKey
        self.fallbackOrder = fallbackOrder
        self.privacyPolicyUrl = privacyPolicyUrl
    }

    /// Whether this provider requires a BYOK API key.
    public var isByok: Bool {
        kind == .byok
    }
}

/// Top-level schema for `web-search-provider-catalog.json`.
///
/// The JSON file is generated from
/// `assistant/src/providers/search-provider-catalog.ts` by
/// `bun run sync:web-search-catalog` and bundled into
/// `VellumAssistantShared` as a SwiftPM resource. The bundled JSON is the
/// single source of truth; if it is missing, unreadable, or corrupt the
/// registry traps at first access — a build/bundling bug, not a runtime
/// fallback condition.
public struct WebSearchProviderCatalog: Decodable {
    public let version: Int
    public let providers: [WebSearchProviderEntry]

    public init(version: Int, providers: [WebSearchProviderEntry]) {
        self.version = version
        self.providers = providers
    }
}

/// Public read accessors for the cached web-search provider catalog.
public enum WebSearchProviderRegistry {
    /// All providers in catalog order.
    public static var providers: [WebSearchProviderEntry] {
        shared.providers
    }

    /// Provider identifiers in catalog order. Convenience for callers
    /// that previously held a hardcoded `[String]` of available providers.
    public static var providerIds: [String] {
        shared.providers.map(\.id)
    }

    /// Display names keyed by provider identifier. Convenience for
    /// callers that previously held a hardcoded `[String: String]` map.
    public static var displayNamesById: [String: String] {
        Dictionary(uniqueKeysWithValues: shared.providers.map { ($0.id, $0.displayName) })
    }

    /// Look up a provider entry by its identifier.
    public static func provider(id: String) -> WebSearchProviderEntry? {
        shared.providers.first { $0.id == id }
    }

    /// The cached catalog for the process lifetime.
    public static var shared: WebSearchProviderCatalog {
        _cachedWebSearchProviderCatalog
    }
}

// MARK: - Loader

/// Cached catalog loaded once per process lifetime.
///
/// The bundled `web-search-provider-catalog.json` is immutable at runtime,
/// so reading it more than once is unnecessary I/O. Swift guarantees
/// thread-safe lazy initialization of static properties.
///
/// Lookup uses `Bundle.vellumShared` rather than SwiftPM's synthesized
/// `Bundle.module`: macOS codesigning requires resources inside
/// `.app/Contents/Resources`, and `Bundle.module` resolves through
/// `Bundle.main.bundleURL` (the `.app` root) which misses that path in
/// shipping builds. The helper tries `.app/Contents/Resources/<bundle>`
/// first, falls back to `swift run`-style adjacency, and handles the
/// Xcode-framework + previews cases that already ship Lucide icons and
/// integration logos. Tests link `VellumAssistantShared` directly so the
/// helper still finds the bundle alongside the xctest binary — the
/// catalog tests exercise the bundled JSON, not a hardcoded mirror.
///
/// A failed lookup here means the JSON was dropped from
/// `clients/Package.swift`, the generator (`sync:web-search-catalog`)
/// failed to refresh it, or the macOS build script stopped copying the
/// SPM `.bundle` artifact into `Contents/Resources`. All build-time bugs
/// — we trap loudly rather than silently degrade.
private let _cachedWebSearchProviderCatalog: WebSearchProviderCatalog = {
    guard let url = Bundle.vellumShared.url(forResource: "web-search-provider-catalog", withExtension: "json") else {
        preconditionFailure(
            "web-search-provider-catalog.json missing from VellumAssistantShared resource bundle — "
            + "check `.copy(\"Resources/web-search-provider-catalog.json\")` in clients/Package.swift, "
            + "that `bun run sync:web-search-catalog` has been run, and that "
            + "`clients/macos/build.sh` copies the SPM bundle into Contents/Resources."
        )
    }
    let data: Data
    do {
        data = try Data(contentsOf: url)
    } catch {
        preconditionFailure(
            "Failed to read bundled web-search-provider-catalog.json: \(error.localizedDescription)"
        )
    }
    do {
        let catalog = try JSONDecoder().decode(WebSearchProviderCatalog.self, from: data)
        guard !catalog.providers.isEmpty else {
            preconditionFailure(
                "Bundled web-search-provider-catalog.json decoded but contains no providers."
            )
        }
        return catalog
    } catch {
        preconditionFailure(
            "Failed to decode bundled web-search-provider-catalog.json: \(error.localizedDescription)"
        )
    }
}()

/// Load the web-search provider catalog from the `VellumAssistantShared`
/// bundle.
///
/// Returns a cached result after the first call — the bundled JSON never
/// changes at runtime so re-reading from disk is unnecessary.
///
/// The bundled JSON is the single source of truth. If it is missing,
/// unreadable, or corrupt the call traps — that's a build/bundling bug
/// to surface immediately, not a runtime condition to paper over.
public func loadWebSearchProviderCatalog() -> WebSearchProviderCatalog {
    WebSearchProviderRegistry.shared
}
