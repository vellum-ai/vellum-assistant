import Foundation

/// Resolved assistant connection info needed by GatewayHTTPClient to
/// construct authenticated requests against gateway / platform endpoints.
public struct ConnectedAssistantInfo {
    public let assistantId: String
    public let gatewayPort: Int?
    public let isManaged: Bool
    public let isRemote: Bool
    public let runtimeUrl: String?

    public init(
        assistantId: String,
        gatewayPort: Int?,
        isManaged: Bool,
        isRemote: Bool,
        runtimeUrl: String?
    ) {
        self.assistantId = assistantId
        self.gatewayPort = gatewayPort
        self.isManaged = isManaged
        self.isRemote = isRemote
        self.runtimeUrl = runtimeUrl
    }
}

/// Resolves the currently connected assistant for gateway HTTP requests.
///
/// macOS provides a lockfile-based implementation; iOS can provide a
/// UserDefaults-based implementation when gateway access is needed.
public protocol ConnectedAssistantResolver {
    @MainActor func resolve() -> ConnectedAssistantInfo?
}
