import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ComputerUseClient")

/// Focused client for watch observation and recording lifecycle operations via the gateway.
public protocol ComputerUseClientProtocol {
    func sendWatchObservation(_ msg: WatchObservationMessage) async -> Bool
    func sendRecordingStatus(_ msg: RecordingStatus) async -> Bool
}

/// Gateway-backed implementation of ``ComputerUseClientProtocol``.
public struct ComputerUseClient: ComputerUseClientProtocol {
    nonisolated public init() {}

    public func sendWatchObservation(_ msg: WatchObservationMessage) async -> Bool {
        do {
            let body = try JSONEncoder().encode(msg)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/computer-use/watch",
                body: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("sendWatchObservation failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendWatchObservation error: \(error.localizedDescription)")
            return false
        }
    }

    public func sendRecordingStatus(_ msg: RecordingStatus) async -> Bool {
        do {
            let body = try JSONEncoder().encode(msg)
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/recordings/status",
                body: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("sendRecordingStatus failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("sendRecordingStatus error: \(error.localizedDescription)")
            return false
        }
    }
}
