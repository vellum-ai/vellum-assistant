import Foundation

/// Parsed semantic version components including optional pre-release tag.
public struct ParsedVersion: Equatable, Comparable {
    public let major: Int
    public let minor: Int
    public let patch: Int
    /// Optional pre-release suffix (e.g. "staging.5", "beta.1"). Nil for release versions.
    public let pre: String?

    /// Whether this version and another share the same major.minor.patch triple,
    /// ignoring any pre-release suffix.
    public func coreEquals(_ other: ParsedVersion) -> Bool {
        major == other.major && minor == other.minor && patch == other.patch
    }

    public static func < (lhs: ParsedVersion, rhs: ParsedVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }

        // Same major.minor.patch — compare pre-release per semver §11
        switch (lhs.pre, rhs.pre) {
        case (nil, nil): return false          // equal
        case (.some, nil): return true         // pre-release < release
        case (nil, .some): return false        // release > pre-release
        case let (.some(a), .some(b)):
            return ParsedVersion.comparePreRelease(a, b) < 0
        }
    }

    /// Compare two pre-release strings per semver §11:
    ///   - Dot-separated identifiers compared left to right.
    ///   - Both numeric → compare as integers.
    ///   - Both non-numeric → compare lexically.
    ///   - Numeric vs non-numeric → numeric sorts lower (§11.4.4).
    ///   - Fewer identifiers sorts earlier when all preceding are equal.
    private static func comparePreRelease(_ a: String, _ b: String) -> Int {
        let pa = a.split(separator: ".").map(String.init)
        let pb = b.split(separator: ".").map(String.init)
        let len = max(pa.count, pb.count)
        for i in 0..<len {
            if i >= pa.count { return -1 }  // a has fewer fields → a < b
            if i >= pb.count { return 1 }
            let aIsNum = pa[i].allSatisfy(\.isNumber) && !pa[i].isEmpty
            let bIsNum = pb[i].allSatisfy(\.isNumber) && !pb[i].isEmpty
            if aIsNum && bIsNum {
                let diff = (Int(pa[i]) ?? 0) - (Int(pb[i]) ?? 0)
                if diff != 0 { return diff }
            } else if aIsNum != bIsNum {
                return aIsNum ? -1 : 1  // numeric < non-numeric per §11.4.4
            } else {
                let cmp = pa[i].compare(pb[i])
                if cmp != .orderedSame { return cmp == .orderedAscending ? -1 : 1 }
            }
        }
        return 0
    }
}

public enum VersionCompat {
    /// Parse a version string into major.minor.patch components with optional pre-release.
    /// Handles optional `v`/`V` prefix (e.g., "v1.2.3", "V1.2.3", or "1.2.3").
    /// Returns nil if the string cannot be parsed.
    public static func parse(_ version: String) -> ParsedVersion? {
        let cleaned = (version.hasPrefix("v") || version.hasPrefix("V")) ? String(version.dropFirst()) : version
        // Split off pre-release suffix (-beta.1) before parsing core version
        let parts = cleaned.split(separator: "-", maxSplits: 1).map(String.init)
        guard let core = parts.first else { return nil }
        let pre: String? = parts.count > 1 ? parts[1] : nil
        // Strip build metadata (+build.123) from pre-release or core
        let cleanPre = pre?.split(separator: "+", maxSplits: 1).first.map(String.init)
        let cleanCore = core.split(separator: "+", maxSplits: 1).first.map(String.init) ?? core
        let segments = cleanCore.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let components = segments.compactMap { Int($0) }
        // Fail-fast if any segment was non-numeric (compactMap silently drops them)
        guard components.count == segments.count,
              components.count >= 2, components.count <= 3 else { return nil }
        return ParsedVersion(
            major: components[0],
            minor: components[1],
            patch: components.count > 2 ? components[2] : 0,
            pre: cleanPre
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
