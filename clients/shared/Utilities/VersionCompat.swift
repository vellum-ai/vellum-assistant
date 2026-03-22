import Foundation

/// Parsed semantic version components.
public struct ParsedVersion: Equatable, Comparable {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public static func < (lhs: ParsedVersion, rhs: ParsedVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        return lhs.patch < rhs.patch
    }
}

public enum VersionCompat {
    /// Parse a version string into major.minor.patch components.
    /// Handles optional `v`/`V` prefix (e.g., "v1.2.3", "V1.2.3", or "1.2.3").
    /// Returns nil if the string cannot be parsed.
    public static func parse(_ version: String) -> ParsedVersion? {
        let cleaned = (version.hasPrefix("v") || version.hasPrefix("V")) ? String(version.dropFirst()) : version
        // Strip pre-release (-beta.1) and build metadata (+build.123) before splitting on dots
        let withoutPreRelease = cleaned.split(separator: "-", maxSplits: 1).first.map(String.init) ?? cleaned
        let withoutBuild = withoutPreRelease.split(separator: "+", maxSplits: 1).first.map(String.init) ?? withoutPreRelease
        let segments = withoutBuild.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let components = segments.compactMap { Int($0) }
        // Fail-fast if any segment was non-numeric (compactMap silently drops them)
        guard components.count == segments.count,
              components.count >= 2, components.count <= 3 else { return nil }
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
