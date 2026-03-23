import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "InteractionClient")

/// Focused client for user interaction responses (confirmations, secrets)
/// routed through the gateway.
@MainActor
public protocol InteractionClientProtocol {
    func sendConfirmationResponse(requestId: String, decision: String, selectedPattern: String?, selectedScope: String?) async -> Bool
    func sendSecretResponse(requestId: String, value: String?, delivery: String?) async -> Bool
}

/// Gateway-backed implementation of ``InteractionClientProtocol``.
@MainActor
public struct InteractionClient: InteractionClientProtocol {
    nonisolated public init() {}

    @discardableResult
    public func sendConfirmationResponse(
        requestId: String,
        decision: String,
        selectedPattern: String? = nil,
        selectedScope: String? = nil
    ) async -> Bool {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
                "decision": decision,
            ]
            if let selectedPattern { body["selectedPattern"] = selectedPattern }
            if let selectedScope { body["selectedScope"] = selectedScope }

            let path = try Self.approvalPath(endpoint: "confirm")
            let response = try await GatewayHTTPClient.post(path: path, json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendConfirmationResponse failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendConfirmationResponse error: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    public func sendAcpPermissionResponse(
        requestId: String,
        optionId: String
    ) async -> Bool {
        do {
            let body: [String: Any] = [
                "requestId": requestId,
                "optionId": optionId,
            ]
            let response = try await GatewayHTTPClient.post(path: "acp/permission", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendAcpPermissionResponse failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendAcpPermissionResponse error: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    public func sendSecretResponse(
        requestId: String,
        value: String? = nil,
        delivery: String? = nil
    ) async -> Bool {
        do {
            var body: [String: Any] = [
                "requestId": requestId,
            ]
            body["value"] = value ?? ""
            if let delivery { body["delivery"] = delivery }

            let path = try Self.approvalPath(endpoint: "secret")
            let response = try await GatewayHTTPClient.post(path: path, json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendSecretResponse failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendSecretResponse error: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Path Resolution

    /// Returns the appropriate request path for an approval endpoint based on
    /// the current connection type.
    ///
    /// Managed connections route through the platform proxy which expects
    /// `assistants/{assistantId}/<endpoint>`. Non-managed connections (local
    /// gateway or direct remote runtime) use flat `<endpoint>` paths.
    private static func approvalPath(endpoint: String) throws -> String {
        let managed = try GatewayHTTPClient.isConnectionManaged()
        return managed ? "assistants/{assistantId}/\(endpoint)" : endpoint
    }
}
