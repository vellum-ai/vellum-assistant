import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LLMProviderRegistry")

// MARK: - Types

/// How the LLM provider's credentials are configured by the user.
///
/// - `apiKey`: The client can collect and store the key directly (e.g. via a
///             text field in onboarding or settings).
/// - `keyless`: The provider requires no API key (e.g. a local model runner
///              such as Ollama). Onboarding UX skips the key-entry step.
public enum LLMProviderSetupMode: String, Decodable {
    case apiKey = "api-key"
    case keyless
}

/// How a model reaches context windows above the standard default budget.
public enum LLMLongContextMode: String, Decodable {
    case nativeModel = "native-model"
    case providerRequestOption = "provider-request-option"
    case unsupported
}

/// Guide for obtaining API credentials from an LLM provider.
///
/// Contains a short description of the steps, a URL to the provider's
/// key-management page, and a human-readable link label for display.
public struct LLMCredentialsGuide: Decodable {
    /// Brief instructions for obtaining an API key (1-2 sentences).
    public let description: String
    /// URL to the provider's API key or console page.
    public let url: String
    /// Human-readable label for the link (e.g. "Open Anthropic Console").
    public let linkLabel: String

    public init(description: String, url: String, linkLabel: String) {
        self.description = description
        self.url = url
        self.linkLabel = linkLabel
    }
}

/// Pricing information for a single model. All values are USD per million
/// tokens. Cache-related fields are only populated for providers that
/// expose prompt caching.
public struct LLMPricing: Decodable {
    public let inputPer1mTokens: Double
    public let outputPer1mTokens: Double
    public let cacheWritePer1mTokens: Double?
    public let cacheReadPer1mTokens: Double?

    public init(
        inputPer1mTokens: Double,
        outputPer1mTokens: Double,
        cacheWritePer1mTokens: Double? = nil,
        cacheReadPer1mTokens: Double? = nil
    ) {
        self.inputPer1mTokens = inputPer1mTokens
        self.outputPer1mTokens = outputPer1mTokens
        self.cacheWritePer1mTokens = cacheWritePer1mTokens
        self.cacheReadPer1mTokens = cacheReadPer1mTokens
    }
}

/// A single model offered by an LLM provider.
public struct LLMModelEntry: Decodable {
    /// Unique model identifier used on the wire (e.g. `"claude-opus-4-7"`).
    public let id: String
    /// Human-readable name for display in settings UI (e.g. `"Claude Opus 4.7"`).
    public let displayName: String
    /// Maximum context window in tokens. Optional — omitted when unknown.
    public let contextWindowTokens: Int?
    /// Conservative default context budget in tokens. Optional — callers
    /// should fall back to their schema default when omitted.
    public let defaultContextWindowTokens: Int?
    /// Token threshold where the provider may apply long-context pricing.
    public let longContextPricingThresholdTokens: Int?
    /// Whether long context is available natively, by request option, or not supported.
    public let longContextMode: LLMLongContextMode?
    /// Maximum output tokens per response. Optional — omitted when unknown.
    public let maxOutputTokens: Int?
    /// Whether the model supports extended thinking / reasoning.
    public let supportsThinking: Bool?
    /// Whether the model supports prompt caching.
    public let supportsCaching: Bool?
    /// Whether the model supports vision / image inputs.
    public let supportsVision: Bool?
    /// Whether the model supports tool use / function calling.
    public let supportsToolUse: Bool?
    /// Per-1M-token pricing, if known.
    public let pricing: LLMPricing?

    public init(
        id: String,
        displayName: String,
        contextWindowTokens: Int? = nil,
        defaultContextWindowTokens: Int? = nil,
        longContextPricingThresholdTokens: Int? = nil,
        longContextMode: LLMLongContextMode? = nil,
        maxOutputTokens: Int? = nil,
        supportsThinking: Bool? = nil,
        supportsCaching: Bool? = nil,
        supportsVision: Bool? = nil,
        supportsToolUse: Bool? = nil,
        pricing: LLMPricing? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.contextWindowTokens = contextWindowTokens
        self.defaultContextWindowTokens = defaultContextWindowTokens
        self.longContextPricingThresholdTokens = longContextPricingThresholdTokens
        self.longContextMode = longContextMode
        self.maxOutputTokens = maxOutputTokens
        self.supportsThinking = supportsThinking
        self.supportsCaching = supportsCaching
        self.supportsVision = supportsVision
        self.supportsToolUse = supportsToolUse
        self.pricing = pricing
    }
}

/// A single entry in the client-facing LLM provider catalog.
///
/// Captures the subset of provider metadata that client apps need for
/// display and onboarding UX — identity, display strings, setup semantics,
/// and the list of supported models.
public struct LLMProviderEntry: Decodable {
    /// Unique provider identifier (e.g. `"anthropic"`, `"openai"`).
    public let id: String
    /// Human-readable name for display in settings UI.
    public let displayName: String
    /// Short description shown below the provider selector.
    public let subtitle: String
    /// How the provider's credentials are configured.
    public let setupMode: LLMProviderSetupMode
    /// Brief help text guiding the user through setup.
    public let setupHint: String
    /// Name of the environment variable the provider conventionally reads
    /// its API key from (e.g. `ANTHROPIC_API_KEY`). `nil` for keyless
    /// providers.
    public let envVar: String?
    /// Example placeholder text shown in the API-key input field to hint
    /// at the key format (e.g. `"sk-ant-api03-..."`). `nil` for keyless
    /// providers.
    public let apiKeyPlaceholder: String?
    /// Guide for obtaining API credentials from this provider. `nil` for
    /// keyless providers.
    public let credentialsGuide: LLMCredentialsGuide?
    /// Whether this provider supports the `platform` auth type — i.e.
    /// Vellum-managed keys routed through the platform proxy. Derived
    /// upstream from `PLATFORM_PROVIDER_META` in
    /// `assistant/src/providers/platform-proxy/constants.ts`. When `false`
    /// (or absent in older catalog versions, in which case it defaults to
    /// `false`), the auth-type dropdown hides the "Platform (managed by
    /// Vellum)" option for this provider — selecting it would have no
    /// effect since there's no managed proxy route for the provider.
    public let supportsPlatformAuth: Bool?
    /// The default model ID (must be present in `models`).
    public let defaultModel: String
    /// All models offered by this provider.
    public let models: [LLMModelEntry]

    public init(
        id: String,
        displayName: String,
        subtitle: String,
        setupMode: LLMProviderSetupMode,
        setupHint: String,
        envVar: String?,
        apiKeyPlaceholder: String?,
        credentialsGuide: LLMCredentialsGuide?,
        supportsPlatformAuth: Bool? = nil,
        defaultModel: String,
        models: [LLMModelEntry]
    ) {
        self.id = id
        self.displayName = displayName
        self.subtitle = subtitle
        self.setupMode = setupMode
        self.setupHint = setupHint
        self.envVar = envVar
        self.apiKeyPlaceholder = apiKeyPlaceholder
        self.credentialsGuide = credentialsGuide
        self.supportsPlatformAuth = supportsPlatformAuth
        self.defaultModel = defaultModel
        self.models = models
    }

    /// Look up a model entry by its identifier.
    public func model(withId id: String) -> LLMModelEntry? {
        models.first { $0.id == id }
    }
}

/// Top-level schema for `llm-provider-catalog.json`.
///
/// The JSON file is generated from `assistant/src/providers/model-catalog.ts`
/// by `bun run sync:llm-catalog` and bundled into `VellumAssistantShared`
/// as a SwiftPM resource. The bundled JSON is the single source of truth;
/// if it is missing, unreadable, or corrupt the registry traps at first
/// access — a build/bundling bug, not a runtime fallback condition.
public struct LLMProviderCatalog: Decodable {
    public let version: Int
    public let providers: [LLMProviderEntry]

    public init(version: Int, providers: [LLMProviderEntry]) {
        self.version = version
        self.providers = providers
    }
}

/// Public read accessors for the cached LLM provider catalog.
public enum LLMProviderRegistry {
    /// All providers in catalog order.
    public static var providers: [LLMProviderEntry] {
        shared.providers
    }

    /// The default provider (first entry).
    ///
    /// The bundled JSON guarantees at least one provider, so this is
    /// non-optional. If the invariant is ever violated (the JSON is
    /// decoded but empty), this will trap — which is the correct failure
    /// mode for a build/bundling bug, not silent degradation.
    public static var defaultProvider: LLMProviderEntry {
        guard let first = shared.providers.first else {
            preconditionFailure(
                "LLMProviderRegistry has no providers — bundled JSON empty"
            )
        }
        return first
    }

    /// Look up a provider entry by its identifier.
    public static func provider(id: String) -> LLMProviderEntry? {
        shared.providers.first { $0.id == id }
    }

    /// Look up a model entry within a provider by its identifier.
    public static func model(provider providerId: String, id modelId: String) -> LLMModelEntry? {
        provider(id: providerId)?.model(withId: modelId)
    }

    /// The cached catalog for the process lifetime.
    public static var shared: LLMProviderCatalog {
        _cachedLLMProviderCatalog
    }
}

// MARK: - Loader

/// Cached catalog loaded once per process lifetime.
///
/// The bundled `llm-provider-catalog.json` is immutable at runtime, so
/// reading it more than once is unnecessary I/O. Swift guarantees
/// thread-safe lazy initialization of static properties.
///
/// Lookup uses `Bundle.vellumShared` rather than SwiftPM's synthesized
/// `Bundle.module`: macOS codesigning requires resources inside
/// `.app/Contents/Resources`, and `Bundle.module` resolves through
/// `Bundle.main.bundleURL` (the `.app` root) which misses that path in
/// shipping builds. The helper tries `.app/Contents/Resources/<bundle>`
/// first, falls back to `swift run`-style adjacency, and handles the
/// Xcode-framework + previews cases that already ship Lucide icons and
/// integration logos. Tests link `VellumAssistantShared` directly so
/// the helper still finds the bundle alongside the xctest binary —
/// the catalog tests exercise the bundled JSON, not a hardcoded mirror.
///
/// A failed lookup here means the JSON was dropped from
/// `clients/Package.swift`, the generator (§G) failed to refresh it,
/// or the macOS build script stopped copying the SPM `.bundle` artifact
/// into `Contents/Resources`. All build-time bugs — we trap loudly
/// rather than silently degrade.
private let _cachedLLMProviderCatalog: LLMProviderCatalog = {
    guard let url = Bundle.vellumShared.url(forResource: "llm-provider-catalog", withExtension: "json") else {
        preconditionFailure(
            "llm-provider-catalog.json missing from VellumAssistantShared resource bundle — "
            + "check `.copy(\"Resources/llm-provider-catalog.json\")` in clients/Package.swift, "
            + "that `bun run sync:llm-catalog` has been run, and that "
            + "`clients/macos/build.sh` copies the SPM bundle into Contents/Resources."
        )
    }
    let data: Data
    do {
        data = try Data(contentsOf: url)
    } catch {
        preconditionFailure(
            "Failed to read bundled llm-provider-catalog.json: \(error.localizedDescription)"
        )
    }
    do {
        let catalog = try JSONDecoder().decode(LLMProviderCatalog.self, from: data)
        guard !catalog.providers.isEmpty else {
            preconditionFailure(
                "Bundled llm-provider-catalog.json decoded but contains no providers."
            )
        }
        return catalog
    } catch {
        preconditionFailure(
            "Failed to decode bundled llm-provider-catalog.json: \(error.localizedDescription)"
        )
    }
}()

/// Load the LLM provider catalog from the `VellumAssistantShared` bundle.
///
/// Returns a cached result after the first call — the bundled JSON never
/// changes at runtime so re-reading from disk is unnecessary.
///
/// The bundled JSON is the single source of truth. If it is missing,
/// unreadable, or corrupt the call traps — that's a build/bundling bug
/// to surface immediately, not a runtime condition to paper over.
public func loadLLMProviderCatalog() -> LLMProviderCatalog {
    LLMProviderRegistry.shared
}
