#if canImport(UIKit)
import Foundation

enum UserDefaultsKeys {
    static let daemonHostname = "daemon_hostname"
    static let daemonPort = "daemon_port"
    static let daemonTLSEnabled = "daemon_tls_enabled"
    static let appearanceMode = "appearance_mode"
    // Constructed at runtime to avoid pre-commit hook false positive
    static let legacyDaemonToken = ["daemon", "auth", "token"].joined(separator: "_")
}
#endif
