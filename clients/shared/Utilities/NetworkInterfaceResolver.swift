#if os(macOS)
import Foundation

/// Detects the local IPv4 address for LAN communication.
/// Prefers en0 (Wi-Fi) > en1 > first non-loopback IPv4, matching the
/// Node.js `network-info.ts` helper's precedence.
public enum NetworkInterfaceResolver {
    /// Returns the best local IPv4 address, or nil if none found.
    public static func getLocalIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else {
            return nil
        }
        defer { freeifaddrs(ifaddr) }

        var addressesByInterface: [String: String] = [:]

        var current: UnsafeMutablePointer<ifaddrs>? = firstAddr
        while let addr = current {
            defer { current = addr.pointee.ifa_next }

            // Only IPv4 (AF_INET). ifa_addr can be NULL for some interfaces (e.g. awdl0, tunnels).
            guard let ifaAddr = addr.pointee.ifa_addr, ifaAddr.pointee.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: addr.pointee.ifa_name)

            // Extract the IPv4 address string
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                ifaAddr,
                socklen_t(ifaAddr.pointee.sa_len),
                &hostname,
                socklen_t(hostname.count),
                nil, 0,
                NI_NUMERICHOST
            )
            guard result == 0 else { continue }
            let ip = String(cString: hostname)

            // Skip loopback and link-local
            if ip.hasPrefix("127.") || ip.hasPrefix("169.254.") { continue }

            addressesByInterface[name] = ip
        }

        // Priority: en0 (Wi-Fi) > en1 > any other
        let priorityInterfaces = ["en0", "en1"]
        for iface in priorityInterfaces {
            if let ip = addressesByInterface[iface] {
                return ip
            }
        }

        // Fallback to first non-loopback
        return addressesByInterface.values.first
    }
}
#endif
