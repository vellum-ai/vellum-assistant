import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChannelClient")

/// Focused client for channel readiness operations routed through the gateway.
@MainActor
public protocol ChannelClientProtocol {
    func fetchChannelReadiness() async -> [String: ChannelReadinessInfo]
}

/// Per-channel readiness state returned by the gateway.
public struct ChannelReadinessInfo: Sendable {
    public let ready: Bool
    public let setupStatus: String?
    public let channelHandle: String?
    public let checks: [ReadinessCheck]

    /// Human-readable reason why this channel is not ready, derived from
    /// the first failing check. Returns `nil` when the channel is ready.
    public var reasonSummary: String? {
        guard !ready else { return nil }
        return checks.first(where: { !$0.passed })?.message
    }

    public init(ready: Bool, setupStatus: String?, channelHandle: String?, checks: [ReadinessCheck]) {
        self.ready = ready
        self.setupStatus = setupStatus
        self.channelHandle = channelHandle
        self.checks = checks
    }
}

/// A single readiness check result from the API.
public struct ReadinessCheck: Sendable {
    public let name: String
    public let passed: Bool
    public let message: String

    public init(name: String, passed: Bool, message: String) {
        self.name = name
        self.passed = passed
        self.message = message
    }
}

/// Gateway-backed implementation of ``ChannelClientProtocol``.
@MainActor
public struct ChannelClient: ChannelClientProtocol {
    nonisolated public init() {}

    private struct ReadinessResponse: Decodable {
        let success: Bool
        let snapshots: [Snapshot]
        struct Snapshot: Decodable {
            let channel: String
            let ready: Bool
            let setupStatus: String?
            let channelHandle: String?
            let localChecks: [CheckResult]?
            let remoteChecks: [CheckResult]?
        }
        struct CheckResult: Decodable {
            let name: String
            let passed: Bool
            let message: String
        }
    }

    public func fetchChannelReadiness() async -> [String: ChannelReadinessInfo] {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/channels/readiness", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchChannelReadiness failed (HTTP \(response.statusCode))")
                return [:]
            }
            let decoded = try JSONDecoder().decode(ReadinessResponse.self, from: response.data)
            var result: [String: ChannelReadinessInfo] = [:]
            for snapshot in decoded.snapshots {
                let checks = ((snapshot.localChecks ?? []) + (snapshot.remoteChecks ?? []))
                    .map { ReadinessCheck(name: $0.name, passed: $0.passed, message: $0.message) }
                result[snapshot.channel] = ChannelReadinessInfo(
                    ready: snapshot.ready,
                    setupStatus: snapshot.setupStatus,
                    channelHandle: snapshot.channelHandle,
                    checks: checks
                )
            }
            return result
        } catch {
            log.error("fetchChannelReadiness error: \(error.localizedDescription)")
            return [:]
        }
    }
}
