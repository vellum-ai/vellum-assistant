import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SurfaceActionClient")

/// Focused client for surface action and undo operations routed through the gateway.
public protocol SurfaceActionClientProtocol {
    func sendSurfaceAction(conversationId: String?, surfaceId: String, actionId: String, data: [String: AnyCodable]?) async
    func sendSurfaceUndo(conversationId: String, surfaceId: String) async
}

/// Standard error envelope returned by /v1/* endpoints — see
/// `assistant/src/runtime/http-errors.ts` (`HttpErrorResponse`). Decoded on
/// non-2xx responses so misfires (e.g. `launch_conversation` with a missing
/// title / seedPrompt) are diagnosable from the client logs alone.
private struct SurfaceActionErrorResponse: Decodable {
    struct ErrorBody: Decodable {
        let code: String
        let message: String
    }
    let error: ErrorBody
}

private func logSurfaceActionFailure(operation: String, statusCode: Int, data: Data) {
    if let decoded = try? JSONDecoder().decode(SurfaceActionErrorResponse.self, from: data) {
        log.error("\(operation, privacy: .public) failed (HTTP \(statusCode)): \(decoded.error.code, privacy: .public) — \(decoded.error.message, privacy: .public)")
        return
    }
    if let raw = String(data: data, encoding: .utf8), !raw.isEmpty {
        let preview = String(raw.prefix(200))
        log.error("\(operation, privacy: .public) failed (HTTP \(statusCode)): \(preview, privacy: .public)")
    } else {
        log.error("\(operation, privacy: .public) failed (HTTP \(statusCode))")
    }
}

/// Gateway-backed implementation of ``SurfaceActionClientProtocol``.
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
            // Omit conversationId — the server resolves the conversation via
            // findSessionBySurfaceId(surfaceId), which is reliable regardless
            // of conversationKey vs conversationId differences.
            if let data {
                body["data"] = data.mapValues { $0.value }
            }

            let response = try await GatewayHTTPClient.post(path: "assistants/{assistantId}/surface-actions", json: body, timeout: 10)
            if !response.isSuccess {
                logSurfaceActionFailure(operation: "sendSurfaceAction", statusCode: response.statusCode, data: response.data)
            }
        } catch {
            log.error("sendSurfaceAction error: \(error.localizedDescription)")
        }
    }

    public func sendSurfaceUndo(conversationId: String, surfaceId: String) async {
        do {
            let body: [String: Any] = [
                "conversationId": conversationId,
                "surfaceId": surfaceId,
            ]
            let response = try await GatewayHTTPClient.post(path: "assistants/{assistantId}/surfaces/\(surfaceId)/undo", json: body, timeout: 10)
            if !response.isSuccess {
                logSurfaceActionFailure(operation: "sendSurfaceUndo", statusCode: response.statusCode, data: response.data)
            }
        } catch {
            log.error("sendSurfaceUndo error: \(error.localizedDescription)")
        }
    }
}
