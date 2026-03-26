import Foundation

/// Static utility for managing per-app host allowlists used by sandboxed webview surfaces.
/// Provides domain normalization, URL matching, and WKContentRuleList JSON generation.
public enum AppHostAllowlist {

    // MARK: - Domain Normalization

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

    // MARK: - URL Matching

    /// Returns `true` if the URL is allowed by the given host list.
    /// Only HTTPS and WSS schemes are permitted. Supports exact match and subdomain matching
    /// (e.g. "example.com" matches "sub.example.com").
    public static func isAllowed(_ url: URL, allowedHosts: [String]) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "wss",
              let host = url.host?.lowercased() else { return false }

        for domain in allowedHosts {
            let normalizedDomain = domain.lowercased()
            if host == normalizedDomain || host.hasSuffix(".\(normalizedDomain)") {
                return true
            }
        }
        return false
    }

    // MARK: - Content Rule List

    /// Generates the WKContentRuleList JSON that blocks all requests except `vellumapp://`,
    /// `about:blank`, and the allowed hosts (each as an `ignore-previous-rules` entry with a
    /// url-filter matching `^(https|wss)://([^/]*\\.)?<escaped-host>(/|$)`).
    public static func contentRuleListJSON(allowedHosts: [String]) -> String {
        var rules: [[String: Any]] = []

        // Block everything by default.
        rules.append([
            "trigger": ["url-filter": ".*"],
            "action": ["type": "block"]
        ])

        // Allow vellumapp:// scheme.
        rules.append([
            "trigger": ["url-filter": "^vellumapp://.*"],
            "action": ["type": "ignore-previous-rules"]
        ])

        // Allow about:blank.
        rules.append([
            "trigger": ["url-filter": "^about:blank$"],
            "action": ["type": "ignore-previous-rules"]
        ])

        // Allow each host (exact + subdomain).
        for host in allowedHosts {
            let escaped = NSRegularExpression.escapedPattern(for: host)
            rules.append([
                "trigger": ["url-filter": "^(https|wss)://([^/]*\\.)?\(escaped)(/|$)"],
                "action": ["type": "ignore-previous-rules"]
            ])
        }

        // Serialize to JSON.
        // swiftlint:disable:next force_try
        let data = try! JSONSerialization.data(withJSONObject: rules, options: [.prettyPrinted, .sortedKeys])
        return String(data: data, encoding: .utf8)!
    }

    // MARK: - Private

    /// Extracts just the host component from a string that may be a full URL.
    private static func extractHost(from value: String) -> String {
        if value.hasPrefix("http://") || value.hasPrefix("https://") {
            if let components = URLComponents(string: value), let host = components.host, !host.isEmpty {
                return host
            }
            return value
        }

        if let slashIndex = value.firstIndex(of: "/") {
            let host = String(value[value.startIndex..<slashIndex])
            return host.isEmpty ? value : host
        }

        return value
    }
}
