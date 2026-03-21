import Foundation

/// Parsed semantic version components.
public struct ParsedVersion {
    public let major: Int
    public let minor: Int
    public let patch: Int
}

public enum VersionCompat {
    /// Parse a version string into major.minor.patch components.
    /// Handles optional `v` prefix (e.g., "v1.2.3" or "1.2.3").
    /// Returns nil if the string cannot be parsed.
    public static func parse(_ version: String) -> ParsedVersion? {
        let cleaned = version.hasPrefix("v") ? String(version.dropFirst()) : version
        // Strip pre-release/build metadata from each segment
        let segments = cleaned.split(separator: ".").map { segment -> String in
            let s = String(segment)
            if let dashIdx = s.firstIndex(of: "-") { return String(s[..<dashIdx]) }
            if let plusIdx = s.firstIndex(of: "+") { return String(s[..<plusIdx]) }
            return s
        }
        let components = segments.compactMap { Int($0) }
        guard components.count >= 2, components.count <= 3 else { return nil }
        return ParsedVersion(
            major: components[0],
            minor: components[1],
            patch: components.count > 2 ? components[2] : 0
        )
    }

    /// Extracts (major, minor) from a version string, stripping pre-release suffixes.
    public static func parseMajorMinor(_ version: String) -> (major: Int, minor: Int)? {
        guard let parsed = parse(version) else { return nil }
        return (parsed.major, parsed.minor)
    }

    /// Check whether two version strings are compatible.
    /// Compatibility requires matching major AND minor versions.
    /// Patch differences are allowed.
    /// Returns false if either version cannot be parsed.
    public static func isCompatible(clientVersion: String, serviceGroupVersion: String) -> Bool {
        guard let client = parse(clientVersion),
              let service = parse(serviceGroupVersion) else {
            return false
        }
        return client.major == service.major && client.minor == service.minor
    }
}
