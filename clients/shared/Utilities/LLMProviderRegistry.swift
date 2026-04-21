import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "LLMProviderRegistry")

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
/// The JSON file is expected to live at `meta/llm-provider-catalog.json`
/// and be copied into `Contents/Resources` by `build.sh` once the later
/// PRs in the LLM catalog plan land. Until then, this registry always
/// returns the fallback data.
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

    /// The default provider (first entry). The fallback guarantees at least
    /// one provider so this is always non-nil in practice, but callers
    /// should treat the optional as authoritative.
    public static var defaultProvider: LLMProviderEntry? {
        shared.providers.first
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

// MARK: - Fallback

/// Hard-coded fallback catalog used when the bundled JSON is missing or
/// corrupt. Keeps client startup resilient — the app can always show at
/// least the current set of providers.
///
/// The entries below mirror the inline catalog in
/// `clients/macos/vellum-assistant/Features/Onboarding/APIKeyEntryStepView.swift`
/// so that fallback behaviour matches what the onboarding flow already
/// shows users. Capability flags and pricing are intentionally omitted in
/// this first scaffold PR; they will be populated in a later PR when the
/// full JSON catalog is wired up.
private let fallbackCatalog = LLMProviderCatalog(
    version: 0,
    providers: [
        LLMProviderEntry(
            id: "anthropic",
            displayName: "Anthropic",
            subtitle: "Claude models from Anthropic. Requires an Anthropic API key.",
            setupMode: .apiKey,
            setupHint: "Enter your Anthropic API key to use Claude.",
            envVar: "ANTHROPIC_API_KEY",
            apiKeyPlaceholder: "sk-ant-api03-...",
            credentialsGuide: LLMCredentialsGuide(
                description: "Sign in to the Anthropic console, go to API Keys, and create a new key.",
                url: "https://console.anthropic.com/settings/keys",
                linkLabel: "Open Anthropic Console"
            ),
            defaultModel: "claude-opus-4-7",
            models: [
                LLMModelEntry(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
                LLMModelEntry(id: "claude-opus-4-6", displayName: "Claude Opus 4.6"),
                LLMModelEntry(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                LLMModelEntry(id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5"),
            ]
        ),
        LLMProviderEntry(
            id: "openai",
            displayName: "OpenAI",
            subtitle: "GPT models from OpenAI. Requires an OpenAI API key.",
            setupMode: .apiKey,
            setupHint: "Enter your OpenAI API key to use GPT models.",
            envVar: "OPENAI_API_KEY",
            apiKeyPlaceholder: "sk-proj-...",
            credentialsGuide: LLMCredentialsGuide(
                description: "Log in to the OpenAI platform, go to API Keys, and generate a new secret key.",
                url: "https://platform.openai.com/api-keys",
                linkLabel: "Open OpenAI Platform"
            ),
            defaultModel: "gpt-5.4",
            models: [
                LLMModelEntry(id: "gpt-5.4", displayName: "GPT-5.4"),
                LLMModelEntry(id: "gpt-5.2", displayName: "GPT-5.2"),
                LLMModelEntry(id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini"),
                LLMModelEntry(id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano"),
            ]
        ),
        LLMProviderEntry(
            id: "gemini",
            displayName: "Google Gemini",
            subtitle: "Gemini models from Google. Requires a Gemini API key.",
            setupMode: .apiKey,
            setupHint: "Enter your Gemini API key to use Google Gemini models.",
            envVar: "GEMINI_API_KEY",
            apiKeyPlaceholder: "AIza...",
            credentialsGuide: LLMCredentialsGuide(
                description: "Visit Google AI Studio, sign in with your Google account, and create an API key.",
                url: "https://aistudio.google.com/apikey",
                linkLabel: "Open Google AI Studio"
            ),
            defaultModel: "gemini-2.5-flash",
            models: [
                LLMModelEntry(id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash"),
                LLMModelEntry(id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite"),
                LLMModelEntry(id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro"),
            ]
        ),
        LLMProviderEntry(
            id: "ollama",
            displayName: "Ollama",
            subtitle: "Run open-source models locally with Ollama. No API key required.",
            setupMode: .keyless,
            setupHint: "Install Ollama locally and pull a model to get started.",
            envVar: nil,
            apiKeyPlaceholder: nil,
            credentialsGuide: nil,
            defaultModel: "llama3.2",
            models: [
                LLMModelEntry(id: "llama3.2", displayName: "Llama 3.2"),
                LLMModelEntry(id: "mistral", displayName: "Mistral"),
            ]
        ),
        LLMProviderEntry(
            id: "fireworks",
            displayName: "Fireworks",
            subtitle: "Open-weight models hosted on Fireworks. Requires a Fireworks API key.",
            setupMode: .apiKey,
            setupHint: "Enter your Fireworks API key to use hosted open-weight models.",
            envVar: "FIREWORKS_API_KEY",
            apiKeyPlaceholder: "fw_...",
            credentialsGuide: LLMCredentialsGuide(
                description: "Sign in to Fireworks, open Account → API Keys, and create a new key.",
                url: "https://fireworks.ai/account/api-keys",
                linkLabel: "Open Fireworks API Keys"
            ),
            defaultModel: "accounts/fireworks/models/kimi-k2p5",
            models: [
                LLMModelEntry(
                    id: "accounts/fireworks/models/kimi-k2p5",
                    displayName: "Kimi K2.5"
                ),
            ]
        ),
        LLMProviderEntry(
            id: "openrouter",
            displayName: "OpenRouter",
            subtitle: "Access many model providers through a single OpenRouter API key.",
            setupMode: .apiKey,
            setupHint: "Enter your OpenRouter API key to access models from multiple providers.",
            envVar: "OPENROUTER_API_KEY",
            apiKeyPlaceholder: "sk-or-v1-...",
            credentialsGuide: LLMCredentialsGuide(
                description: "Sign in to OpenRouter, open Keys, and create a new API key.",
                url: "https://openrouter.ai/keys",
                linkLabel: "Open OpenRouter Keys"
            ),
            defaultModel: "x-ai/grok-4.20-beta",
            models: [
                // xAI
                LLMModelEntry(id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta"),
                LLMModelEntry(id: "x-ai/grok-4", displayName: "Grok 4"),
                // DeepSeek
                LLMModelEntry(id: "deepseek/deepseek-r1-0528", displayName: "DeepSeek R1"),
                LLMModelEntry(id: "deepseek/deepseek-chat-v3-0324", displayName: "DeepSeek V3"),
                // Qwen
                LLMModelEntry(id: "qwen/qwen3.5-plus-02-15", displayName: "Qwen 3.5 Plus"),
                LLMModelEntry(id: "qwen/qwen3.5-397b-a17b", displayName: "Qwen 3.5 397B"),
                LLMModelEntry(id: "qwen/qwen3.5-flash-02-23", displayName: "Qwen 3.5 Flash"),
                LLMModelEntry(id: "qwen/qwen3-coder-next", displayName: "Qwen 3 Coder"),
                // Moonshot
                LLMModelEntry(id: "moonshotai/kimi-k2.5", displayName: "Kimi K2.5"),
                // Mistral
                LLMModelEntry(id: "mistralai/mistral-medium-3", displayName: "Mistral Medium 3"),
                LLMModelEntry(id: "mistralai/mistral-small-2603", displayName: "Mistral Small 4"),
                LLMModelEntry(id: "mistralai/devstral-2512", displayName: "Devstral 2"),
                // Meta
                LLMModelEntry(id: "meta-llama/llama-4-maverick", displayName: "Llama 4 Maverick"),
                LLMModelEntry(id: "meta-llama/llama-4-scout", displayName: "Llama 4 Scout"),
                // Amazon
                LLMModelEntry(id: "amazon/nova-pro-v1", displayName: "Amazon Nova Pro"),
            ]
        ),
    ]
)

// MARK: - Loader

/// Cached catalog loaded once per process lifetime.
/// The bundled `llm-provider-catalog.json` (when present in later PRs)
/// is immutable at runtime, so reading it more than once is unnecessary
/// I/O. Swift guarantees thread-safe lazy initialization of static
/// properties.
private let _cachedLLMProviderCatalog: LLMProviderCatalog = {
    guard let url = Bundle.main.url(forResource: "llm-provider-catalog", withExtension: "json") else {
        log.warning("llm-provider-catalog.json not found in bundle — using fallback catalog")
        return fallbackCatalog
    }
    guard let data = try? Data(contentsOf: url) else {
        log.error("Failed to read llm-provider-catalog.json from bundle")
        return fallbackCatalog
    }
    do {
        let catalog = try JSONDecoder().decode(LLMProviderCatalog.self, from: data)
        guard !catalog.providers.isEmpty else {
            log.error("llm-provider-catalog.json decoded but contains no providers — using fallback catalog")
            return fallbackCatalog
        }
        return catalog
    } catch {
        log.error("Failed to decode llm-provider-catalog.json: \(error.localizedDescription, privacy: .public)")
        return fallbackCatalog
    }
}()

/// Load the LLM provider catalog from the app bundle's Resources.
///
/// Returns a cached result after the first call — the bundled JSON never
/// changes at runtime so re-reading from disk is unnecessary.
///
/// If the JSON file is missing, unreadable, or corrupt the function
/// returns a hard-coded fallback containing the current provider set so
/// that client startup is never blocked.
public func loadLLMProviderCatalog() -> LLMProviderCatalog {
    LLMProviderRegistry.shared
}
