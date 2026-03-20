import Foundation
import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "WatchSession")

@MainActor
public final class WatchSession: ObservableObject {
    public enum State { case idle, capturing, complete, cancelled }

    @Published public var state: State = .idle
    @Published public var captureCount: Int = 0
    @Published public var totalExpected: Int = 0
    @Published public var elapsedSeconds: Double = 0
    @Published public var currentApp: String = ""

    public let watchId: String
    public let conversationId: String
    public let durationSeconds: Int
    public let intervalSeconds: Int

    private var daemonClient: (any DaemonClientProtocol)?
    private let computerUseClient: any ComputerUseClientProtocol = ComputerUseClient()
    private var captureTask: Task<Void, Never>?
    private var elapsedTask: Task<Void, Never>?
    private var startedAt: Date?
    private let screenCapture = ScreenCapture()
    private let ocr = ScreenOCR()
    private var previousOcrText: String = ""

    public init(watchId: String, conversationId: String, durationSeconds: Int, intervalSeconds: Int) {
        self.watchId = watchId
        self.conversationId = conversationId
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
    }

    public func start(daemonClient: any DaemonClientProtocol) {
        self.daemonClient = daemonClient
        state = .capturing
        totalExpected = durationSeconds / intervalSeconds
        elapsedSeconds = 0
        startedAt = Date()
        log.info("Watch session started: watchId=\(self.watchId) duration=\(self.durationSeconds)s interval=\(self.intervalSeconds)s")
        captureTask = Task { [weak self] in
            await self?.captureLoop()
        }
        elapsedTask = Task { [weak self] in
            await self?.elapsedLoop()
        }
    }

    public func stop() {
        captureTask?.cancel()
        captureTask = nil
        elapsedTask?.cancel()
        elapsedTask = nil
        startedAt = nil
        state = .cancelled
        log.info("Watch session stopped: watchId=\(self.watchId)")
    }

    private func captureLoop() async {
        guard let startedAt else { return }

        while !Task.isCancelled {
            if Date().timeIntervalSince(startedAt) >= Double(durationSeconds) {
                break
            }
            // Try AX capture first
            let snapshot = await AmbientAXCapture.capture()
            var screenContent: String
            var appName: String
            var windowTitle: String?
            var bundleIdentifier: String?

            if let snapshot, AmbientAXCapture.isUseful(snapshot) {
                screenContent = AmbientAXCapture.format(snapshot)
                appName = snapshot.focusedAppName
                windowTitle = snapshot.focusedWindowTitle
                bundleIdentifier = snapshot.focusedApp
            } else {
                // Fall back to screenshot + OCR
                guard PermissionManager.screenRecordingStatus() == .granted else {
                    log.debug("Screen recording not permitted - skipping OCR fallback")
                    try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                    continue
                }

                let screenshotData: Data
                do {
                    screenshotData = try await screenCapture.captureScreen()
                } catch {
                    log.warning("Screenshot failed: \(error.localizedDescription)")
                    try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                    continue
                }
                screenContent = await ocr.recognizeText(from: screenshotData)
                appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"
                windowTitle = currentWindowTitle()
                bundleIdentifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            }

            currentApp = appName

            // Skip empty content
            guard !screenContent.isEmpty else {
                log.debug("Screen content empty — skipping observation")
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                continue
            }

            // Similarity check - skip if >85% similar to previous capture
            let similarity = ScreenOCR.similarity(screenContent, previousOcrText)
            if similarity > 0.85 {
                log.debug("Screen unchanged (similarity=\(String(format: "%.2f", similarity))) — skipping observation \(appName)")
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                continue
            }
            log.debug("Screen changed (similarity=\(String(format: "%.2f", similarity))) — will send observation for \(appName)")
            previousOcrText = screenContent

            captureCount += 1

            // Send watch_observation to daemon
            let observation = WatchObservationMessage(
                watchId: watchId,
                conversationId: conversationId,
                ocrText: screenContent,
                appName: appName,
                windowTitle: windowTitle,
                bundleIdentifier: bundleIdentifier,
                timestamp: Date().timeIntervalSince1970 * 1000,
                captureIndex: captureCount,
                totalExpected: totalExpected
            )

            log.debug("Sending observation \(self.captureCount)/\(self.totalExpected) watchId=\(self.watchId) ocrLen=\(screenContent.count)")
            let success = await computerUseClient.sendWatchObservation(observation)
            if success {
                log.debug("Observation \(self.captureCount) sent successfully for \(appName)")
            } else {
                log.error("Failed to send watch observation")
            }

            try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
        }

        if !Task.isCancelled {
            elapsedSeconds = Double(durationSeconds)
            elapsedTask?.cancel()
            elapsedTask = nil
            self.startedAt = nil
            state = .complete
            log.info("Watch session complete: watchId=\(self.watchId) captures=\(self.captureCount)")
        }
    }

    private func elapsedLoop() async {
        guard let startedAt else { return }

        while !Task.isCancelled {
            let elapsed = min(Date().timeIntervalSince(startedAt), Double(durationSeconds))
            elapsedSeconds = elapsed
            if elapsed >= Double(durationSeconds) {
                return
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func currentWindowTitle() -> String? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let appRef = AXUIElementCreateApplication(app.processIdentifier)
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        let window = value as! AXUIElement
        var titleValue: AnyObject?
        guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue) == .success else {
            return nil
        }
        return titleValue as? String
    }
}
