import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "NotificationClient")

/// Focused client for notification delivery acknowledgments.
@MainActor
public protocol NotificationClientProtocol {
    func sendIntentResult(deliveryId: String, success: Bool, errorMessage: String?, errorCode: String?) async
}

/// Gateway-backed implementation of ``NotificationClientProtocol``.
@MainActor
public struct NotificationClient: NotificationClientProtocol {
    nonisolated public init() {}

    public func sendIntentResult(deliveryId: String, success: Bool, errorMessage: String?, errorCode: String?) async {
        do {
            var body: [String: Any] = [
                "deliveryId": deliveryId,
                "success": success
            ]
            if let errorMessage { body["errorMessage"] = errorMessage }
            if let errorCode { body["errorCode"] = errorCode }

            let response = try await GatewayHTTPClient.post(
                path: "notification-intent-result", json: body, timeout: 10
            )
            if !response.isSuccess {
                log.error("sendIntentResult failed (HTTP \(response.statusCode)) for deliveryId \(deliveryId)")
            }
        } catch {
            log.error("sendIntentResult error for deliveryId \(deliveryId): \(error.localizedDescription)")
        }
    }
}
