import Foundation
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Shared scaffolding for the inference-profile and call-site-override
/// test suites. The four `InferenceProfile*Tests` and
/// `SettingsStoreInferenceProfilesTests` plus `CallSiteOverridesSheetTests`
/// each rebuilt the same `MockSettingsClient` + `SettingsStore` +
/// provider-catalog literal in their `setUp`. This factory bundles those
/// pieces so individual tests only override what they care about.
@MainActor
enum SettingsTestFixture {

    /// Builds a `(store, mockClient)` pair with `patchConfigResponse = true`.
    /// Optionally installs a provider catalog.
    static func make(
        providerCatalog: [ProviderCatalogEntry]? = nil
    ) -> (store: SettingsStore, mockClient: MockSettingsClient) {
        let mockClient = MockSettingsClient()
        mockClient.patchConfigResponse = true
        let store = SettingsStore(settingsClient: mockClient)
        if let providerCatalog {
            store.providerCatalog = providerCatalog
        }
        return (store, mockClient)
    }

    // MARK: - Provider catalog fixtures

    /// Anthropic + OpenAI with `claude-sonnet-4-6`, `claude-opus-4-7`, and
    /// `gpt-5`. Used by the editor and inference-card tests.
    static func anthropicAndOpenAICatalog(
        anthropicApiKeyPlaceholder: String? = nil,
        openaiApiKeyPlaceholder: String? = nil
    ) -> [ProviderCatalogEntry] {
        [
            ProviderCatalogEntry(
                id: "anthropic",
                displayName: "Anthropic",
                models: [
                    CatalogModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                    CatalogModel(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
                ],
                defaultModel: "claude-sonnet-4-6",
                apiKeyUrl: nil,
                apiKeyPlaceholder: anthropicApiKeyPlaceholder
            ),
            ProviderCatalogEntry(
                id: "openai",
                displayName: "OpenAI",
                models: [
                    CatalogModel(id: "gpt-5", displayName: "GPT-5"),
                ],
                defaultModel: "gpt-5",
                apiKeyUrl: nil,
                apiKeyPlaceholder: openaiApiKeyPlaceholder
            ),
        ]
    }

    /// Anthropic-only catalog with sonnet 4.6, opus 4.7, and haiku 4.5.
    /// Used by the sheet tests, which need a haiku entry for the
    /// cost-optimized built-in profile's display name lookup.
    static let anthropicWithHaikuCatalog: [ProviderCatalogEntry] = [
        ProviderCatalogEntry(
            id: "anthropic",
            displayName: "Anthropic",
            models: [
                CatalogModel(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
                CatalogModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                CatalogModel(id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5"),
            ],
            defaultModel: "claude-sonnet-4-6",
            apiKeyUrl: nil,
            apiKeyPlaceholder: nil
        ),
    ]

    // MARK: - Built-in profile payloads

    /// Mirrors the daemon's migration-052 seed: the three canonical
    /// built-in inference profiles (quality-optimized, balanced,
    /// cost-optimized).
    static let builtInProfilesPayload: [String: Any] = [
        "quality-optimized": [
            "provider": "anthropic",
            "model": "claude-opus-4-7",
            "maxTokens": 32000,
            "effort": "max",
            "thinking": ["enabled": true, "streamThinking": true],
        ],
        "balanced": [
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "maxTokens": 16000,
            "effort": "high",
            "thinking": ["enabled": true, "streamThinking": true],
        ],
        "cost-optimized": [
            "provider": "anthropic",
            "model": "claude-haiku-4-5-20251001",
            "maxTokens": 8192,
            "effort": "low",
            "thinking": ["enabled": false, "streamThinking": false],
        ],
    ]
}
