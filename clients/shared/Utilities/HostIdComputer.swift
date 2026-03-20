#if os(macOS)
import CryptoKit
import Foundation
import IOKit

/// Single source of truth for computing a stable, privacy-safe macOS host identifier.
///
/// The identifier is a SHA-256 hash of the IOPlatformUUID combined with an
/// app-specific salt. This produces a deterministic, non-reversible device ID
/// that stays consistent across app launches.
public enum HostIdComputer {

    /// Compute a stable host identifier from the IOPlatformUUID.
    /// Falls back to a random UUID if the platform UUID cannot be read.
    public static func computeHostId() -> String {
        let platformUUID = getPlatformUUID() ?? UUID().uuidString
        let salt = "vellum-assistant-host-id"
        let input = Data((platformUUID + salt).utf8)
        let hash = SHA256.hash(data: input)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Read the IOPlatformUUID from the IORegistry (macOS hardware identifier).
    private static func getPlatformUUID() -> String? {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        let key = kIOPlatformUUIDKey as CFString
        guard let uuid = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String else {
            return nil
        }
        return uuid
    }
}
#endif
