import CryptoKit
import Foundation
import IOKit
@preconcurrency import Sentry

/// Privacy-safe device identification and Sentry scope configuration.
/// Uses the same SHA-256(IOPlatformUUID + salt) approach as PairingQRCodeSheet.computeHostId().
enum SentryDeviceInfo {
    /// A stable, hashed device identifier derived from the hardware UUID.
    /// Computed once and cached for the process lifetime.
    static let deviceId: String = {
        let platformUUID = getPlatformUUID() ?? UUID().uuidString
        let salt = "vellum-assistant-host-id"
        let input = Data((platformUUID + salt).utf8)
        let hash = SHA256.hash(data: input)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }()

    /// Sentry environment string matching the daemon convention in instrument.ts.
    static let sentryEnvironment: String = {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }()

    /// Configures the Sentry scope with device and assistant tags.
    /// Call after every `SentrySDK.start` (AppDelegate init, MetricKitManager restart,
    /// manual report temporary start) so all events carry filtering context.
    static func configureSentryScope() {
        SentrySDK.configureScope { scope in
            scope.setTag(value: deviceId, key: "device_id")
            scope.setTag(value: ProcessInfo.processInfo.hostName, key: "hostname")
            if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") {
                scope.setTag(value: assistantId, key: "assistant_id")
            }
            scope.setTag(value: ProcessInfo.processInfo.operatingSystemVersionString, key: "os_version")
        }
    }

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
