import Foundation

public struct DaemonConfig {
    #if os(macOS)
    /// Transport mode for communicating with the assistant daemon.
    public enum Transport {
        /// Local Unix domain socket (default for local assistants).
        case socket(path: String)
        /// HTTP + SSE via a remote gateway URL (for cloud/custom assistants).
        case http(baseURL: String, bearerToken: String?, conversationKey: String)
    }

    public let transport: Transport

    /// Socket path, for backwards compatibility.
    /// Returns the socket path if using socket transport, otherwise the default path.
    public var socketPath: String {
        switch transport {
        case .socket(let path):
            return path
        case .http:
            return resolveSocketPath()
        }
    }

    public init(transport: Transport) {
        self.transport = transport
    }

    /// Convenience initializer for socket transport (backwards compatible).
    public init(socketPath: String) {
        self.transport = .socket(path: socketPath)
    }

    public static var `default`: DaemonConfig {
        // Delegate to resolveSocketPath() to avoid duplication
        return DaemonConfig(transport: .socket(path: resolveSocketPath()))
    }
    #elseif os(iOS)
    public let hostname: String
    public let port: UInt16

    /// Whether to use TLS for the TCP connection (iOS only).
    public var tlsEnabled: Bool

    /// Authentication token for the daemon TCP handshake (iOS only).
    public var authToken: String?

    public init(hostname: String, port: UInt16, tlsEnabled: Bool = false, authToken: String? = nil) {
        self.hostname = hostname
        self.port = port
        self.tlsEnabled = tlsEnabled
        self.authToken = authToken
    }

    public static var `default`: DaemonConfig {
        return DaemonConfig(hostname: "localhost", port: 8765)
    }

    /// Create a `DaemonConfig` populated from UserDefaults / Keychain, falling back to safe defaults.
    /// Reads: `daemon_hostname`, `daemon_port`, `daemon_tls_enabled` from UserDefaults;
    /// reads auth token from Keychain via `APIKeyManager` (provider: `"daemon-token"`),
    /// with a one-time migration from the legacy `daemon_auth_token` UserDefaults key.
    public static func fromUserDefaults() -> DaemonConfig {
        // Treat empty string as nil to ensure fallback to "localhost"
        let hostname = UserDefaults.standard.string(forKey: "daemon_hostname").flatMap { $0.isEmpty ? nil : $0 } ?? "localhost"
        let rawPort = UserDefaults.standard.integer(forKey: "daemon_port")
        // Validate port is in valid UInt16 range (1-65535) before converting to avoid crash
        let finalPort: UInt16 = (rawPort > 0 && rawPort <= 65535) ? UInt16(rawPort) : 8765
        let tlsEnabled = UserDefaults.standard.bool(forKey: "daemon_tls_enabled")
        let authToken = APIKeyManager.shared.getAPIKey(provider: "daemon-token") ?? migrateAuthToken()
        return DaemonConfig(hostname: hostname, port: finalPort, tlsEnabled: tlsEnabled, authToken: authToken)
    }

    /// One-time migration: reads the legacy `daemon_auth_token` UserDefaults key, persists it
    /// to Keychain, removes the old key, and returns the value. Returns nil if no legacy token exists.
    static func migrateAuthToken() -> String? {
        guard let legacy = UserDefaults.standard.string(forKey: "daemon_auth_token"), !legacy.isEmpty else {
            return nil
        }
        guard APIKeyManager.shared.setAPIKey(legacy, provider: "daemon-token") else {
            // Keychain write failed — keep the legacy key so the next launch can retry migration.
            return legacy
        }
        UserDefaults.standard.removeObject(forKey: "daemon_auth_token")
        return legacy
    }
    #else
    #error("Unsupported platform")
    #endif
}
