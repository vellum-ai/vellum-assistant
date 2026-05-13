import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChannelClient")

/// Focused client for channel readiness + availability operations routed through the gateway.
public protocol ChannelClientProtocol {
    func fetchChannelReadiness() async -> [String: ChannelReadinessInfo]

    /// Channels this assistant can surface to clients, in display order,
    /// each carrying the display metadata the UI needs (label, subtitle,
    /// icon, verification capability, setup-message copy).
    ///
    /// Returns `nil` when the gateway can't be reached so callers can
    /// fall back to a static default; never block the UI on availability
    /// failures.
    func fetchChannelAvailability() async -> [ChannelInfo]?
}

/// Per-channel display metadata returned by the gateway alongside the
/// channel id. Mirrors the `ChannelInfo` interface in
/// `assistant/src/channels/types.ts` — the gateway is the source of
/// truth for labels, icons, and verification capability so clients never
/// need their own per-channel switches.
public struct ChannelInfo: Sendable, Decodable, Equatable {
    public let id: String
    public let label: String
    public let subtitle: String
    /// Lucide icon name without the `lucide-` prefix (e.g. `"mail"`,
    /// `"hash"`). Resolve to `VIcon` via `VIcon(rawValue: "lucide-\(icon)")`.
    public let icon: String
    public let supportsVerification: Bool
    public let setupMessages: SetupMessages

    public struct SetupMessages: Sendable, Decodable, Equatable {
        public let guardian: String
        public let contact: String

        public init(guardian: String, contact: String) {
            self.guardian = guardian
            self.contact = contact
        }
    }

    public init(
        id: String,
        label: String,
        subtitle: String,
        icon: String,
        supportsVerification: Bool,
        setupMessages: SetupMessages
    ) {
        self.id = id
        self.label = label
        self.subtitle = subtitle
        self.icon = icon
        self.supportsVerification = supportsVerification
        self.setupMessages = setupMessages
    }
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
                path: "channels/readiness", timeout: 10
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

    private struct AvailabilityResponse: Decodable {
        let channels: [ChannelInfo]
    }

    public func fetchChannelAvailability() async -> [ChannelInfo]? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "channels/available", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchChannelAvailability failed (HTTP \(response.statusCode))")
                return nil
            }
            let decoded = try JSONDecoder().decode(AvailabilityResponse.self, from: response.data)
            return decoded.channels
        } catch {
            log.error("fetchChannelAvailability error: \(error.localizedDescription)")
            return nil
        }
    }
}
