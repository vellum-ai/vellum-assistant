import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "PairingClient")

/// Focused client for pairing approval and device management operations routed through the gateway.
@MainActor
public protocol PairingClientProtocol {
    func sendPairingApprovalResponse(pairingRequestId: String, decision: String) async throws -> Bool
    func fetchApprovedDevices() async throws -> [ApprovedDevicesListResponseMessage.Device]
    func removeApprovedDevice(hashedDeviceId: String) async throws -> Bool
    func clearApprovedDevices() async throws -> Bool
}

/// Gateway-backed implementation of ``PairingClientProtocol``.
@MainActor
public struct PairingClient: PairingClientProtocol {
    nonisolated public init() {}

    enum PairingClientError: LocalizedError {
        case httpError(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .httpError(let statusCode):
                return "Pairing request failed (HTTP \(statusCode))"
            }
        }
    }

    public func sendPairingApprovalResponse(pairingRequestId: String, decision: String) async throws -> Bool {
        let body: [String: Any] = [
            "type": "pairing_approval_response",
            "pairingRequestId": pairingRequestId,
            "decision": decision,
        ]
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/pairing/register", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("sendPairingApprovalResponse failed (HTTP \(response.statusCode))")
            return false
        }
        return true
    }

    public func fetchApprovedDevices() async throws -> [ApprovedDevicesListResponseMessage.Device] {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/pairing/register", timeout: 10
        )
        guard response.isSuccess else {
            throw PairingClientError.httpError(statusCode: response.statusCode)
        }
        let patched = injectType("approved_devices_list_response", into: response.data)
        return try JSONDecoder().decode(ApprovedDevicesListResponseMessage.self, from: patched).devices
    }

    public func removeApprovedDevice(hashedDeviceId: String) async throws -> Bool {
        let body: [String: Any] = [
            "type": "approved_device_remove",
            "hashedDeviceId": hashedDeviceId,
        ]
        let response = try await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/pairing/register", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("removeApprovedDevice failed (HTTP \(response.statusCode))")
            return false
        }
        return true
    }

    public func clearApprovedDevices() async throws -> Bool {
        let response = try await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/pairing/register", timeout: 10
        )
        guard response.isSuccess else {
            log.error("clearApprovedDevices failed (HTTP \(response.statusCode))")
            return false
        }
        return true
    }

    // MARK: - Helpers

    /// Injects the `"type"` discriminant required by `Codable` decoding of
    /// server message types whose JSON payloads omit it over HTTP.
    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
