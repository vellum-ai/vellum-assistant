import Foundation

/// Validates whether a host string refers to a local or private-network address.
/// Used to allow plain HTTP for LAN/loopback endpoints while requiring HTTPS
/// for public hosts (ATS policy). Shared across iOS and macOS targets.
public enum LocalAddressValidator {

    /// Returns `true` if the given host is a loopback, mDNS (.local), IPv6 link-local,
    /// or RFC 1918 private address. Comparison is case-insensitive.
    ///
    /// This validates the raw part count before checking IPv4 octets, preventing
    /// bypass via crafted hostnames like `10.0.0.1.evil.com`.
    public static func isLocalAddress(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased()

        // Empty host is never local
        if host.isEmpty { return false }

        // Loopback & mDNS
        if host == "localhost" || host == "::1" || host.hasSuffix(".local") {
            return true
        }

        // IPv6 link-local (fe80::...)
        if host.hasPrefix("fe80:") {
            return true
        }

        // IPv4: split on "." and require exactly 4 parts before parsing octets.
        // This prevents bypass via hostnames like "10.0.0.1.evil.com" where
        // compactMap alone would yield 4 valid octets from 6 dot-separated parts.
        let parts = host.split(separator: ".")
        if parts.count == 4 {
            let octets = parts.compactMap { UInt8($0) }
            if octets.count == 4 {
                // 127.0.0.0/8 -- full loopback range
                if octets[0] == 127 { return true }
                // 10.0.0.0/8 -- private
                if octets[0] == 10 { return true }
                // 172.16.0.0/12 -- private (172.16.x.x through 172.31.x.x)
                if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
                // 192.168.0.0/16 -- private
                if octets[0] == 192 && octets[1] == 168 { return true }
            }
        }

        return false
    }
}
