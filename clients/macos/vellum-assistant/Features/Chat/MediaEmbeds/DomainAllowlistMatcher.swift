import Foundation

enum DomainAllowlistMatcher {
    /// Returns true if the URL's host matches any domain in the allowlist.
    /// Supports exact and subdomain matching (e.g., "youtube.com" matches "www.youtube.com").
    static func isAllowed(_ url: URL, allowedDomains: [String]) -> Bool {
        guard url.scheme == "https",
              let host = url.host?.lowercased() else { return false }

        for domain in allowedDomains {
            let normalizedDomain = domain.lowercased()
            if host == normalizedDomain || host.hasSuffix(".\(normalizedDomain)") {
                return true
            }
        }
        return false
    }
}
