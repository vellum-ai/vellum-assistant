import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ProviderEnvVarRegistry")

/// Top-level schema for `provider-env-vars.json`.
///
/// The JSON file lives at `meta/provider-env-vars.json` and is the single
/// source of truth for **search-provider** env var mappings (e.g. Brave,
/// Perplexity). LLM-provider env vars live in the LLM provider catalog
/// (`meta/llm-provider-catalog.json`, surfaced via `LLMProviderRegistry`).
/// Callers that need the combined LLM + search mapping should merge both
/// sources — see `VellumCli.providerEnvVars` for the canonical combination.
public struct ProviderEnvVarRegistry: Decodable {
    public let version: Int
    /// Provider identifiers (e.g. "brave") mapped to their env var name
    /// (e.g. "BRAVE_API_KEY").
    public let providers: [String: String]
}

/// Load the provider env-var registry from the app bundle's Resources.
///
/// The `provider-env-vars.json` file is copied into `Contents/Resources`
/// by `build.sh` alongside other shared configuration files.
public func loadProviderEnvVarRegistry() -> ProviderEnvVarRegistry? {
    guard let url = Bundle.main.url(forResource: "provider-env-vars", withExtension: "json") else {
        log.warning("provider-env-vars.json not found in bundle — using empty registry")
        return nil
    }
    guard let data = try? Data(contentsOf: url) else {
        log.error("Failed to read provider-env-vars.json from bundle")
        return nil
    }
    do {
        return try JSONDecoder().decode(ProviderEnvVarRegistry.self, from: data)
    } catch {
        log.error("Failed to decode provider-env-vars.json: \(error.localizedDescription, privacy: .public)")
        return nil
    }
}
