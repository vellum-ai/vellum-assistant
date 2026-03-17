import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ScheduleClient")

/// Focused client for schedule management operations routed through the gateway.
@MainActor
public protocol ScheduleClientProtocol {
    func fetchSchedulesList() async throws -> [ScheduleItem]
    func toggleSchedule(id: String, enabled: Bool) async throws -> [ScheduleItem]
    func deleteSchedule(id: String) async throws -> [ScheduleItem]
    func cancelSchedule(id: String) async throws -> [ScheduleItem]
}

/// Gateway-backed implementation of ``ScheduleClientProtocol``.
@MainActor
public struct ScheduleClient: ScheduleClientProtocol {
    nonisolated public init() {}

    enum ScheduleClientError: LocalizedError {
        case httpError(statusCode: Int)

        var errorDescription: String? {
            switch self {
            case .httpError(let statusCode):
                return "Schedule request failed (HTTP \(statusCode))"
            }
        }
    }

    private struct SchedulesResponse: Decodable {
        let schedules: [ScheduleItem]
    }

    public func fetchSchedulesList() async throws -> [ScheduleItem] {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/schedules", timeout: 10
        )
        guard response.isSuccess else {
            log.error("fetchSchedulesList failed (HTTP \(response.statusCode))")
            throw ScheduleClientError.httpError(statusCode: response.statusCode)
        }
        return try JSONDecoder().decode(SchedulesResponse.self, from: response.data).schedules
    }

    public func toggleSchedule(id: String, enabled: Bool) async throws -> [ScheduleItem] {
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/schedules/\(id)/toggle",
            json: ["enabled": enabled],
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("toggleSchedule failed (HTTP \(response.statusCode))")
            throw ScheduleClientError.httpError(statusCode: response.statusCode)
        }
        return try JSONDecoder().decode(SchedulesResponse.self, from: response.data).schedules
    }

    public func deleteSchedule(id: String) async throws -> [ScheduleItem] {
        let response = try await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/schedules/\(id)", timeout: 10
        )
        guard response.isSuccess else {
            log.error("deleteSchedule failed (HTTP \(response.statusCode))")
            throw ScheduleClientError.httpError(statusCode: response.statusCode)
        }
        return try JSONDecoder().decode(SchedulesResponse.self, from: response.data).schedules
    }

    public func cancelSchedule(id: String) async throws -> [ScheduleItem] {
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/schedules/\(id)/cancel",
            json: [:],
            timeout: 10
        )
        guard response.isSuccess else {
            log.error("cancelSchedule failed (HTTP \(response.statusCode))")
            throw ScheduleClientError.httpError(statusCode: response.statusCode)
        }
        return try JSONDecoder().decode(SchedulesResponse.self, from: response.data).schedules
    }
}
