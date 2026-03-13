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

/// How endpoint paths are constructed for HTTP transport.
public enum RouteMode {
    /// Current runtime-flat paths: `/healthz`, `/v1/messages`, etc.
    case runtimeFlat
    /// Platform assistant proxy paths: `/v1/assistants/{id}/healthz/`, etc.
    case platformAssistantProxy
}

/// How authentication headers are applied for HTTP transport.
public enum AuthMode {
    /// `Authorization: Bearer {token}` (current default for local/gateway).
    case bearerToken
    /// `X-Session-Token: {token}` from SessionTokenManager (managed mode).
    case sessionToken
}

/// Optional metadata that governs how HTTP transport constructs URLs and
/// applies authentication. Defaults preserve existing behavior so this
/// is a no-op refactor when not explicitly configured.
public struct TransportMetadata {
    public let routeMode: RouteMode
    public let authMode: AuthMode
    /// Platform-assigned assistant UUID, required for `.platformAssistantProxy` route mode.
    public let platformAssistantId: String?

    public init(
        routeMode: RouteMode = .runtimeFlat,
        authMode: AuthMode = .bearerToken,
        platformAssistantId: String? = nil
    ) {
        self.routeMode = routeMode
        self.authMode = authMode
        self.platformAssistantId = platformAssistantId
    }

    /// Default metadata preserving existing local/gateway behavior.
    public static let defaultLocal = TransportMetadata(
        routeMode: .runtimeFlat,
        authMode: .bearerToken,
        platformAssistantId: nil
    )
}

public struct DaemonConfig {
    /// Transport mode for communicating with the assistant daemon.
    /// All platforms use HTTP + SSE exclusively.
    public enum Transport {
        /// HTTP + SSE transport (used for both local and remote assistants).
        case http(baseURL: String, bearerToken: String?, conversationKey: String)
    }

    public let transport: Transport

    /// Metadata governing URL construction and auth for HTTP transport.
    /// Defaults to `.defaultLocal` which preserves existing behavior.
    public let transportMetadata: TransportMetadata

    /// Instance directory for multi-instance support (e.g. `~/.vellum/instances/alice`).
    /// When set, token resolution uses this directory instead of the lockfile's latest entry.
    public let instanceDir: String?

    /// Feature-flag bearer token for authenticating PATCH /v1/feature-flags/:flagKey requests.
    /// On macOS this is read from `~/.vellum/feature-flag-token`.
    /// On iOS this is received during QR pairing and stored in the Keychain.
    public let featureFlagToken: String?

    #if os(macOS)
    public static var `default`: DaemonConfig {
        let portString = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "7821"
        let port = Int(portString) ?? 7821
        let baseURL = "http://localhost:\(port)"
        return DaemonConfig(transport: .http(
            baseURL: baseURL,
            bearerToken: nil,
            conversationKey: UUID().uuidString
        ))
    }
    #endif

    public init(transport: Transport, transportMetadata: TransportMetadata = .defaultLocal, instanceDir: String? = nil, featureFlagToken: String? = nil) {
        self.transport = transport
        self.transportMetadata = transportMetadata
        self.instanceDir = instanceDir
        #if os(macOS)
        self.featureFlagToken = featureFlagToken ?? readFeatureFlagToken()
        #else
        self.featureFlagToken = featureFlagToken
        #endif
    }

    #if os(iOS)
    // MARK: - iOS defaults (HTTP+SSE only)

    /// iOS uses HTTP+SSE exclusively. Default returns an HTTP config if a gateway/runtime
    /// URL is configured, otherwise a non-connecting placeholder.
    public static var `default`: DaemonConfig {
        return fromUserDefaults()
    }

    /// Create a `DaemonConfig` populated from UserDefaults / Keychain.
    public static func fromUserDefaults() -> DaemonConfig {
        let featureFlagToken = APIKeyManager.shared.getAPIKey(provider: "feature-flag-token")

        // Managed assistant: cloud-hosted via platform proxy with session token auth.
        // Set after Vellum login + managed bootstrap completes.
        if let managedAssistantId = UserDefaults.standard.string(forKey: "managed_assistant_id"),
           !managedAssistantId.isEmpty,
           let platformBaseURL = UserDefaults.standard.string(forKey: "managed_platform_base_url"),
           !platformBaseURL.isEmpty {
            let metadata = TransportMetadata(
                routeMode: .platformAssistantProxy,
                authMode: .sessionToken,
                platformAssistantId: managedAssistantId
            )
            return DaemonConfig(
                transport: .http(
                    baseURL: platformBaseURL,
                    bearerToken: nil,
                    conversationKey: managedAssistantId
                ),
                transportMetadata: metadata,
                featureFlagToken: featureFlagToken
            )
        }

        // gateway_base_url is set by QR pairing (v4).
        let httpBaseURL = UserDefaults.standard.string(forKey: "gateway_base_url").flatMap { $0.isEmpty ? nil : $0 }
        if let baseURL = httpBaseURL {
            let bearerToken = APIKeyManager.shared.getAPIKey(provider: "runtime-bearer-token")
            let conversationKey: String
            if let stored = UserDefaults.standard.string(forKey: "conversation_key"), !stored.isEmpty {
                conversationKey = stored
            } else {
                conversationKey = UUID().uuidString
                UserDefaults.standard.set(conversationKey, forKey: "conversation_key")
            }
            return DaemonConfig(transport: .http(baseURL: baseURL, bearerToken: bearerToken, conversationKey: conversationKey), featureFlagToken: featureFlagToken)
        }

        // No gateway URL configured — return a placeholder HTTP config that won't connect.
        // The user needs to pair via QR code (which sets gateway_base_url) before connecting.
        return DaemonConfig(transport: .http(baseURL: "", bearerToken: nil, conversationKey: ""), featureFlagToken: featureFlagToken)
    }
    #endif
}
