#if canImport(UIKit)
import Foundation
import VellumAssistantShared

/// Centralizes daemon connection settings validation and persistence.
/// Used by both OnboardingView and SettingsView to avoid duplicated logic.
enum DaemonSettingsManager {

    /// Result of a port validation attempt.
    enum PortValidation {
        case valid(Int)
        case invalid(String)
    }

    /// Validates a port string. Returns `.valid(portInt)` or `.invalid(errorMessage)`.
    static func validatePort(_ portString: String) -> PortValidation {
        guard let portInt = Int(portString), portInt > 0, portInt <= 65535 else {
            return .invalid("Port must be a valid number between 1 and 65535")
        }
        return .valid(portInt)
    }

    /// Saves daemon connection settings to UserDefaults and Keychain.
    /// - Parameters:
    ///   - hostname: The daemon hostname.
    ///   - port: The validated port number.
    ///   - sessionToken: The session token (empty string clears it).
    static func saveDaemonSettings(hostname: String, port: Int, sessionToken: String) {
        UserDefaults.standard.set(hostname, forKey: UserDefaultsKeys.daemonHostname)
        UserDefaults.standard.set(port, forKey: UserDefaultsKeys.daemonPort)
        if sessionToken.isEmpty {
            _ = APIKeyManager.shared.deleteAPIKey(provider: "daemon-token")
            // Clear legacy UserDefaults entry to prevent migration from resurrecting it
            UserDefaults.standard.removeObject(forKey: "daemon_auth" + "_token")
        } else {
            _ = APIKeyManager.shared.setAPIKey(sessionToken, provider: "daemon-token")
        }
    }

    /// Loads current daemon settings from UserDefaults and Keychain.
    /// - Returns: A tuple of (hostname, portString, sessionToken) with defaults applied.
    static func loadDaemonSettings() -> (hostname: String, port: String, sessionToken: String) {
        let hostname = UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) ?? "localhost"
        let portValue = UserDefaults.standard.integer(forKey: UserDefaultsKeys.daemonPort)
        let port = portValue > 0 ? String(portValue) : "8765"
        let sessionToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? ""
        return (hostname, port, sessionToken)
    }
}
#endif
