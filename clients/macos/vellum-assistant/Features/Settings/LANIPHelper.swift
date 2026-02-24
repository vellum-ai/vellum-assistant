import Foundation

/// Discovers the Mac's LAN IPv4 address by enumerating network interfaces.
/// Returns the first non-loopback, up, IPv4 address on an en* interface (Wi-Fi or Ethernet),
/// or nil if no suitable address is found.
enum LANIPHelper {
    static func currentLANAddress() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else {
            return nil
        }
        defer { freeifaddrs(ifaddr) }

        var result: String?
        var current: UnsafeMutablePointer<ifaddrs>? = firstAddr

        while let addr = current {
            let flags = Int32(addr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0

            // Only consider interfaces that are up and not loopback
            if isUp, !isLoopback,
               let sa = addr.pointee.ifa_addr,
               sa.pointee.sa_family == UInt8(AF_INET) {

                let name = String(cString: addr.pointee.ifa_name)
                // Filter to en* interfaces (en0 = Wi-Fi, en1 = Ethernet, etc.)
                if name.hasPrefix("en") {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(sa, socklen_t(sa.pointee.sa_len),
                                   &hostname, socklen_t(hostname.count),
                                   nil, 0, NI_NUMERICHOST) == 0 {
                        result = String(cString: hostname)
                        break
                    }
                }
            }
            current = addr.pointee.ifa_next
        }

        return result
    }
}
