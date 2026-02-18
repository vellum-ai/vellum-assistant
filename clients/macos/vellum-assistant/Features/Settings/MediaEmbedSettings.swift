import Foundation

/// Centralized defaults and helpers for the media-embed feature.
/// Later PRs will wire these into SettingsStore and the embed pipeline;
/// for now this is a pure-value model with no side effects.
public enum MediaEmbedSettings {

    /// Whether media embeds are turned on by default for new installs.
    public static let defaultEnabled = true

    /// Domains whose URLs are eligible for inline embed rendering.
    public static let defaultDomains: [String] = [
        "youtube.com",
        "youtu.be",
        "vimeo.com",
        "loom.com",
    ]

    /// Returns the current date, suitable for persisting the moment the user
    /// enabled embeds so we only embed links from messages created after that point.
    public static func enabledSinceNow() -> Date {
        Date()
    }

    /// Normalizes a user-provided domain list: trims whitespace, lowercases,
    /// removes empty strings, and deduplicates while preserving first-occurrence order.
    public static func normalizeDomains(_ domains: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for domain in domains {
            let normalized = domain.trimmingCharacters(in: .whitespaces).lowercased()
            guard !normalized.isEmpty, !seen.contains(normalized) else { continue }
            seen.insert(normalized)
            result.append(normalized)
        }
        return result
    }
}
