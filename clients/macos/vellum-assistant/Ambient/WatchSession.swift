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
    public let sessionId: String
    public let durationSeconds: Int
    public let intervalSeconds: Int

    private var daemonClient: DaemonClient?
    private var captureTask: Task<Void, Never>?
    private let screenCapture = ScreenCapture()
    private let ocr = ScreenOCR()
    private var previousOcrText: String = ""

    public init(watchId: String, sessionId: String, durationSeconds: Int, intervalSeconds: Int) {
        self.watchId = watchId
        self.sessionId = sessionId
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
    }

    public func start(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        state = .capturing
        totalExpected = durationSeconds / intervalSeconds
        log.info("Watch session started: watchId=\(self.watchId) duration=\(self.durationSeconds)s interval=\(self.intervalSeconds)s")
        captureTask = Task { await captureLoop() }
    }

    public func stop() {
        captureTask?.cancel()
        captureTask = nil
        state = .cancelled
        log.info("Watch session stopped: watchId=\(self.watchId)")
    }

    private func captureLoop() async {
        let startTime = Date()

        while !Task.isCancelled && elapsedSeconds < Double(durationSeconds) {
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
                    elapsedSeconds = Date().timeIntervalSince(startTime)
                    continue
                }

                let screenshotData: Data
                do {
                    screenshotData = try await screenCapture.captureScreen()
                } catch {
                    log.warning("Screenshot failed: \(error.localizedDescription)")
                    try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                    elapsedSeconds = Date().timeIntervalSince(startTime)
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
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                elapsedSeconds = Date().timeIntervalSince(startTime)
                continue
            }

            // Similarity check - skip if >85% similar to previous capture
            if ScreenOCR.similarity(screenContent, previousOcrText) > 0.85 {
                log.debug("Screen unchanged (similarity > 0.85) - skipping observation")
                try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
                elapsedSeconds = Date().timeIntervalSince(startTime)
                continue
            }
            previousOcrText = screenContent

            captureCount += 1

            // Send watch_observation to daemon
            let observation = WatchObservationMessage(
                watchId: watchId,
                sessionId: sessionId,
                ocrText: screenContent,
                appName: appName,
                windowTitle: windowTitle,
                bundleIdentifier: bundleIdentifier,
                timestamp: Date().timeIntervalSince1970 * 1000,
                captureIndex: captureCount,
                totalExpected: totalExpected
            )

            do {
                try daemonClient?.send(observation)
                log.info("Sent watch observation \(self.captureCount)/\(self.totalExpected) for \(appName)")
            } catch {
                log.warning("Failed to send watch observation: \(error.localizedDescription)")
            }

            try? await Task.sleep(nanoseconds: UInt64(intervalSeconds) * 1_000_000_000)
            elapsedSeconds = Date().timeIntervalSince(startTime)
        }

        if !Task.isCancelled {
            state = .complete
            log.info("Watch session complete: watchId=\(self.watchId) captures=\(self.captureCount)")
        }
    }

    private func currentWindowTitle() -> String? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let appRef = AXUIElementCreateApplication(app.processIdentifier)
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute as CFString, &value) == .success else {
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
