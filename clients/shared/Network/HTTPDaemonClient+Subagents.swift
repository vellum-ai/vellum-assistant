import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Subagents Domain Dispatcher

extension HTTPTransport {

    func registerSubagentsRoutes() {
        registerDomainDispatcher { message in
            if message is SubagentMessageRequest {
                // Handled by SubagentClient via GatewayHTTPClient.
                return true
            }

            return false
        }
    }

    // MARK: - Conversation ID Translation

    /// Given a client-local conversation ID, find the corresponding server conversation ID
    /// by doing a reverse lookup in `serverToLocalConversationMap`. Returns the original ID
    /// if no mapping exists (the ID is already a server conversation ID, e.g. restored conversations).
    func serverConversationId(forLocal localId: String) -> String {
        for (serverId, mappedLocalId) in serverToLocalConversationMap {
            if mappedLocalId == localId {
                return serverId
            }
        }
        return localId
    }
}
