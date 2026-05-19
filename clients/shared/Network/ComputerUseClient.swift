import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ComputerUseClient")

/// Focused client for watch observation and recording lifecycle operations via the gateway.
public protocol ComputerUseClientProtocol {
    func sendWatchObservation(_ msg: WatchObservationMessage) async -> Bool
    func sendRecordingStatus(_ msg: RecordingStatus) async -> Bool
    /// Publish a `screen_snapshot` perception event alongside the legacy
    /// `watch_observation` path. Best-effort — failures are logged at debug
    /// and never bubble to the watch loop.
    func sendScreenSnapshotPerception(_ msg: ScreenSnapshotPerceptionMessage) async -> Bool
}

/// Gateway-backed implementation of ``ComputerUseClientProtocol``.
public struct ComputerUseClient: ComputerUseClientProtocol {
    nonisolated public init() {}

    public func sendWatchObservation(_ msg: WatchObservationMessage) async -> Bool {
        do {
            let body = try JSONEncoder().encode(msg)
            let response = try await GatewayHTTPClient.post(
                path: "computer-use/watch",
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
                path: "recordings/status",
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

    public func sendScreenSnapshotPerception(_ msg: ScreenSnapshotPerceptionMessage) async -> Bool {
        do {
            let body = try JSONEncoder().encode(msg)
            let response = try await GatewayHTTPClient.post(
                path: "perception/publish",
                body: body,
                timeout: 10
            )
            guard response.isSuccess else {
                log.debug("sendScreenSnapshotPerception non-success HTTP \(response.statusCode) — perception may be disabled or consent missing")
                return false
            }
            return true
        } catch {
            log.debug("sendScreenSnapshotPerception error: \(error.localizedDescription)")
            return false
        }
    }
}

// MARK: - Screen snapshot perception envelope

/// Wire-compatible payload for the daemon's `perception/publish` route when
/// emitting `screen_snapshot` events. The redacted/truncated OCR text MUST
/// already be capped to 2048 characters by the producer.
public struct ScreenSnapshotPerceptionMessage: Codable {
    public struct Source: Codable {
        public let module: String
        public let version: String?

        public init(module: String, version: String? = nil) {
            self.module = module
            self.version = version
        }
    }

    public struct Payload: Codable {
        public let kind: String
        public let appId: String
        public let appName: String
        public let windowTitle: String
        public let ocrTextRedacted: String
        public let redacted: Bool
        public let captureMethod: String
        public let confidence: Double

        public init(
            appId: String,
            appName: String,
            windowTitle: String,
            ocrTextRedacted: String,
            redacted: Bool,
            captureMethod: String,
            confidence: Double
        ) {
            self.kind = "screen_snapshot"
            self.appId = appId
            self.appName = appName
            self.windowTitle = windowTitle
            self.ocrTextRedacted = ocrTextRedacted
            self.redacted = redacted
            self.captureMethod = captureMethod
            self.confidence = confidence
        }
    }

    public let eventId: String
    public let ts: String
    public let source: Source
    public let payload: Payload

    public init(eventId: String, ts: String, source: Source, payload: Payload) {
        self.eventId = eventId
        self.ts = ts
        self.source = source
        self.payload = payload
    }
}
