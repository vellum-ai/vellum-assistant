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
        var trimmed = version
        if trimmed.first == "v" || trimmed.first == "V" {
            trimmed.removeFirst()
        }

        let components = trimmed.split(separator: ".")
        guard components.count >= 2, components.count <= 3 else {
            return nil
        }

        guard let major = Int(components[0]),
              let minor = Int(components[1]) else {
            return nil
        }

        let patch: Int
        if components.count == 3 {
            guard let p = Int(components[2]) else {
                return nil
            }
            patch = p
        } else {
            patch = 0
        }

        return ParsedVersion(major: major, minor: minor, patch: patch)
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
