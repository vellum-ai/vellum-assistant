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

    /// Normalizes a user-provided domain list: trims whitespace and newlines, lowercases,
    /// strips URL schemes/paths/query strings/fragments, removes empty strings,
    /// and deduplicates while preserving first-occurrence order.
    public static func normalizeDomains(_ domains: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for domain in domains {
            var normalized = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !normalized.isEmpty else { continue }
            normalized = extractHost(from: normalized)
            guard !normalized.isEmpty, !seen.contains(normalized) else { continue }
            seen.insert(normalized)
            result.append(normalized)
        }
        return result
    }

    /// Extracts just the host component from a string that may be a full URL.
    /// If the string has an http/https scheme, the host is pulled via URLComponents.
    /// If it contains a `/` (e.g. `youtube.com/watch`), the part before the first `/` is returned.
    /// Otherwise the string is returned as-is.
    private static func extractHost(from value: String) -> String {
        // If the value has an http(s) scheme, use URLComponents to extract the host.
        if value.hasPrefix("http://") || value.hasPrefix("https://") {
            if let components = URLComponents(string: value), let host = components.host, !host.isEmpty {
                return host
            }
            // Scheme was present but URLComponents couldn't extract a host;
            // return the original value rather than slicing at the scheme's slashes.
            return value
        }

        // No scheme — strip anything after the first `/` (path, query, fragment).
        if let slashIndex = value.firstIndex(of: "/") {
            let host = String(value[value.startIndex..<slashIndex])
            return host.isEmpty ? value : host
        }

        return value
    }
}
