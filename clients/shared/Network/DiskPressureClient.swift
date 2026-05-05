import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "DiskPressureClient")

public protocol DiskPressureClientProtocol: Sendable {
    func getStatus() async throws -> DiskPressureStatus
    func acknowledge() async throws -> DiskPressureStatus
    func overrideLock(confirmation: String) async throws -> DiskPressureStatus
}

public enum DiskPressureClientError: Error, LocalizedError, Sendable {
    case requestFailed(statusCode: Int)
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .requestFailed(let statusCode):
            return "Disk pressure request failed (HTTP \(statusCode))"
        case .invalidResponse:
            return "Disk pressure response could not be decoded"
        }
    }
}

public struct DiskPressureClient: DiskPressureClientProtocol {
    public init() {}

    public func getStatus() async throws -> DiskPressureStatus {
        let response = try await GatewayHTTPClient.get(
            path: "disk-pressure/status",
            timeout: 10
        )
        return try decodeStatusResponse(response, operation: "getStatus")
    }

    public func acknowledge() async throws -> DiskPressureStatus {
        let response = try await GatewayHTTPClient.post(
            path: "disk-pressure/acknowledge",
            timeout: 10
        )
        return try decodeStatusResponse(response, operation: "acknowledge")
    }

    public func overrideLock(confirmation: String) async throws -> DiskPressureStatus {
        let response = try await GatewayHTTPClient.post(
            path: "disk-pressure/override",
            json: ["confirmation": confirmation],
            timeout: 10
        )
        return try decodeStatusResponse(response, operation: "override")
    }

    private func decodeStatusResponse(
        _ response: GatewayHTTPClient.Response,
        operation: String
    ) throws -> DiskPressureStatus {
        guard response.isSuccess else {
            log.error("\(operation, privacy: .public) failed (HTTP \(response.statusCode))")
            throw DiskPressureClientError.requestFailed(statusCode: response.statusCode)
        }

        do {
            return try JSONDecoder().decode(DiskPressureStatusResponse.self, from: response.data).status
        } catch {
            log.error("\(operation, privacy: .public) decode failed: \(error.localizedDescription)")
            throw DiskPressureClientError.invalidResponse
        }
    }
}
