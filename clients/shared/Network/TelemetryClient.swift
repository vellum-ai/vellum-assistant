import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TelemetryClient")

/// Focused client for telemetry operations routed through the gateway.
@MainActor
public protocol TelemetryClientProtocol {
    func recordLifecycleEvent(_ eventName: String) async
}

/// Gateway-backed implementation of ``TelemetryClientProtocol``.
@MainActor
public struct TelemetryClient: TelemetryClientProtocol {
    nonisolated public init() {}

    /// Record a lifecycle telemetry event (e.g. app_open, hatch).
    /// Fire-and-forget — failures are logged but do not propagate.
    public func recordLifecycleEvent(_ eventName: String) async {
        let body: [String: Any] = ["event_name": eventName]
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/telemetry/lifecycle",
                json: body,
                timeout: 10
            )
            if !response.isSuccess {
                log.warning("Lifecycle event '\(eventName)' recording failed (HTTP \(response.statusCode))")
            }
        } catch {
            log.warning("Lifecycle event '\(eventName)' recording error: \(error.localizedDescription)")
        }
    }
}
