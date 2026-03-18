import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SurfaceActionClient")

/// Focused client for surface action and undo operations routed through the gateway.
@MainActor
public protocol SurfaceActionClientProtocol {
    func sendSurfaceAction(conversationId: String?, surfaceId: String, actionId: String, data: [String: AnyCodable]?) async
    func sendSurfaceUndo(conversationId: String, surfaceId: String) async
}

/// Gateway-backed implementation of ``SurfaceActionClientProtocol``.
@MainActor
public struct SurfaceActionClient: SurfaceActionClientProtocol {
    nonisolated public init() {}

    public func sendSurfaceAction(
        conversationId: String?,
        surfaceId: String,
        actionId: String,
        data: [String: AnyCodable]? = nil
    ) async {
        do {
            var body: [String: Any] = [
                "surfaceId": surfaceId,
                "actionId": actionId,
            ]
            if let conversationId { body["conversationId"] = conversationId }
            if let data {
                body["data"] = data.mapValues { $0.value }
            }

            let response = try await GatewayHTTPClient.post(path: "surface-actions", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendSurfaceAction failed (HTTP \(response.statusCode))")
            }
        } catch {
            log.error("sendSurfaceAction error: \(error.localizedDescription)")
        }
    }

    public func sendSurfaceUndo(conversationId: String, surfaceId: String) async {
        do {
            let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? surfaceId
            let body: [String: Any] = [
                "conversationId": conversationId,
                "surfaceId": surfaceId,
            ]
            let response = try await GatewayHTTPClient.post(path: "surfaces/\(encoded)/undo", json: body, timeout: 10)
            if !response.isSuccess {
                log.error("sendSurfaceUndo failed (HTTP \(response.statusCode))")
            }
        } catch {
            log.error("sendSurfaceUndo error: \(error.localizedDescription)")
        }
    }
}
