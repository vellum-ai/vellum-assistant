import Foundation

/// Identity fields fetched from a remote assistant's identity endpoint.
public struct RemoteIdentityInfo: Decodable {
    public let name: String
    public let role: String
    public let personality: String
    public let emoji: String
    public let version: String?
    public let assistantId: String?
    public let home: String?
    public let createdAt: String?
    public let originSystem: String?

    public init(
        name: String,
        role: String,
        personality: String,
        emoji: String,
        version: String? = nil,
        assistantId: String? = nil,
        home: String? = nil,
        createdAt: String? = nil,
        originSystem: String? = nil
    ) {
        self.name = name
        self.role = role
        self.personality = personality
        self.emoji = emoji
        self.version = version
        self.assistantId = assistantId
        self.home = home
        self.createdAt = createdAt
        self.originSystem = originSystem
    }
}

public struct DaemonConfig {
    /// Transport mode for communicating with the assistant daemon.
    public enum Transport {
        /// Local Unix domain socket (macOS only).
        #if os(macOS)
        case socket(path: String)
        /// TCP connection to a daemon (macOS only — iOS uses HTTP+SSE exclusively).
        case tcp(hostname: String, port: UInt16, tlsEnabled: Bool, authToken: String?)
        #endif
        /// HTTP + SSE via a remote gateway URL (for cloud/custom assistants).
        case http(baseURL: String, bearerToken: String?, conversationKey: String)
    }

    public let transport: Transport

    #if os(macOS)
    /// Socket path, for backwards compatibility.
    /// Returns the socket path if using socket transport, otherwise the default path.
    public var socketPath: String {
        switch transport {
        case .socket(let path):
            return path
        case .http, .tcp:
            return resolveSocketPath()
        }
    }

    /// Convenience initializer for socket transport (backwards compatible).
    public init(socketPath: String) {
        self.transport = .socket(path: socketPath)
    }

    public static var `default`: DaemonConfig {
        return DaemonConfig(transport: .socket(path: resolveSocketPath()))
    }
    #endif

    public init(transport: Transport) {
        self.transport = transport
    }

    #if os(iOS)
    // MARK: - iOS defaults (HTTP+SSE only — no TCP)

    /// iOS uses HTTP+SSE exclusively. Default returns an HTTP config if a gateway/runtime
    /// URL is configured, otherwise a non-connecting placeholder.
    public static var `default`: DaemonConfig {
        return fromUserDefaults()
    }

    /// Create a `DaemonConfig` populated from UserDefaults / Keychain.
    /// iOS only supports HTTP+SSE transport via the gateway — no TCP fallback.
    public static func fromUserDefaults() -> DaemonConfig {
        // Check for a stored gateway or runtime URL — if present, use HTTP transport.
        // gateway_base_url is set by QR pairing v2; runtime_url is the legacy/cloud key.
        let httpBaseURL = UserDefaults.standard.string(forKey: "gateway_base_url").flatMap { $0.isEmpty ? nil : $0 }
            ?? UserDefaults.standard.string(forKey: "runtime_url").flatMap { $0.isEmpty ? nil : $0 }
        if let baseURL = httpBaseURL {
            let bearerToken = APIKeyManager.shared.getAPIKey(provider: "runtime-bearer-token")
            let conversationKey: String
            if let stored = UserDefaults.standard.string(forKey: "conversation_key"), !stored.isEmpty {
                conversationKey = stored
            } else {
                conversationKey = UUID().uuidString
                UserDefaults.standard.set(conversationKey, forKey: "conversation_key")
            }
            return DaemonConfig(transport: .http(baseURL: baseURL, bearerToken: bearerToken, conversationKey: conversationKey))
        }

        // No gateway URL configured — return a placeholder HTTP config that won't connect.
        // The user needs to pair via QR code (which sets gateway_base_url) before connecting.
        return DaemonConfig(transport: .http(baseURL: "", bearerToken: nil, conversationKey: ""))
    }
    #endif
}
