import Foundation
import AppKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AmbientAgent")

enum AmbientAgentState: Equatable {
    case idle
    case watching
    case analyzing
    case paused
    case disabled
}

@MainActor
final class AmbientAgent: ObservableObject {
    @Published var state: AmbientAgentState = .disabled {
        didSet { appDelegate?.updateMenuBarIcon() }
    }
    @Published var lastSuggestion: String?
    @Published var cycleCount: Int = 0

    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "ambientAgentEnabled") }
        set {
            if newValue {
                start()
                // Only persist enabled if start() actually succeeded
                UserDefaults.standard.set(watchTask != nil, forKey: "ambientAgentEnabled")
            } else {
                UserDefaults.standard.set(false, forKey: "ambientAgentEnabled")
                stop()
            }
        }
    }

    var captureIntervalSeconds: Double {
        get { UserDefaults.standard.double(forKey: "ambientCaptureInterval").clamped(to: 10...120, default: 30) }
        set { UserDefaults.standard.set(newValue, forKey: "ambientCaptureInterval") }
    }

    private let screenCapture = ScreenCapture()
    private let ocr = ScreenOCR()
    private let knowledgeStore = KnowledgeStore()
    private var analyzer: AmbientAnalyzer?
    private var watchTask: Task<Void, Never>?
    private var activeSuggestionWindow: AmbientSuggestionWindow?
    private var previousOCRText: String = ""

    weak var appDelegate: AppDelegate?

    var knowledge: KnowledgeStore { knowledgeStore }

    func start() {
        guard watchTask == nil else { return }
        guard let apiKey = APIKeyManager.getKey() else {
            log.warning("Cannot start ambient agent: no API key")
            return
        }

        analyzer = AmbientAnalyzer(apiKey: apiKey)
        state = .watching
        log.info("Ambient agent started (interval: \(self.captureIntervalSeconds)s)")

        watchTask = Task { @MainActor [weak self] in
            await self?.watchLoop()
        }
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
        analyzer = nil
        state = .disabled
        log.info("Ambient agent stopped")
    }

    func pause() {
        state = .paused
        log.info("Ambient agent paused")
    }

    func resume() {
        if watchTask != nil {
            state = .watching
            log.info("Ambient agent resumed")
        }
    }

    private func watchLoop() async {
        while !Task.isCancelled {
            // Wait for the configured interval
            let intervalNs = UInt64(captureIntervalSeconds * 1_000_000_000)
            try? await Task.sleep(nanoseconds: intervalNs)

            guard !Task.isCancelled else { break }

            // Skip if paused, disabled, or a manual session is running
            guard state == .watching else { continue }
            if appDelegate?.currentSession != nil { continue }

            await runCycle()
        }
    }

    private func runCycle() async {
        cycleCount += 1
        let cycle = cycleCount

        // Tier 0: Capture + OCR + diff
        let screenshot: Data
        do {
            screenshot = try await screenCapture.captureScreen()
        } catch {
            log.warning("[\(cycle)] Screenshot failed: \(error.localizedDescription)")
            return
        }

        state = .analyzing
        let ocrText = await ocr.recognizeText(from: screenshot)

        guard !ocrText.isEmpty else {
            log.debug("[\(cycle)] OCR returned empty text — skipping")
            state = .watching
            return
        }

        // Check similarity with previous capture
        let similarity = ScreenOCR.similarity(previousOCRText, ocrText)
        if similarity > 0.85 {
            log.debug("[\(cycle)] Screen unchanged (similarity: \(String(format: "%.2f", similarity))) — skipping")
            state = .watching
            return
        }
        previousOCRText = ocrText

        // Get active app info
        let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"
        let windowTitle = currentWindowTitle() ?? "Unknown"

        log.info("[\(cycle)] Tier 1: Analyzing \(appName) — \"\(windowTitle)\" (\(ocrText.count) chars OCR)")

        // Tier 1: Send to Haiku
        guard let analyzer = analyzer else { return }

        let result: AmbientAnalysisResult
        do {
            result = try await analyzer.analyze(
                ocrText: ocrText,
                appName: appName,
                windowTitle: windowTitle,
                knowledgeContext: knowledgeStore.formattedContext()
            )
        } catch {
            log.warning("[\(cycle)] Analysis failed: \(error.localizedDescription)")
            state = .watching
            return
        }

        switch result.decision {
        case .ignore:
            log.debug("[\(cycle)] Decision: ignore — \(result.reasoning)")

        case .observe:
            if let observation = result.observation {
                knowledgeStore.addEntry(
                    category: "observation",
                    observation: observation,
                    sourceApp: appName,
                    confidence: result.confidence
                )
            }

        case .suggest:
            if let suggestion = result.suggestion, result.confidence > 0.8 {
                log.info("[\(cycle)] Suggestion: \(suggestion)")
                lastSuggestion = suggestion
                showSuggestion(suggestion)
            } else {
                log.debug("[\(cycle)] Suggestion below confidence threshold (\(String(format: "%.2f", result.confidence)))")
            }
        }

        state = .watching
    }

    private func showSuggestion(_ suggestion: String) {
        guard let appDelegate = appDelegate else { return }
        let window = AmbientSuggestionWindow(
            suggestion: suggestion,
            onAccept: { [weak self] in
                self?.activeSuggestionWindow = nil
                self?.lastSuggestion = nil
                appDelegate.startSession(task: suggestion)
            },
            onDismiss: { [weak self] in
                self?.activeSuggestionWindow = nil
                self?.lastSuggestion = nil
            }
        )
        activeSuggestionWindow = window
        window.show()
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

private extension Double {
    func clamped(to range: ClosedRange<Double>, default defaultValue: Double) -> Double {
        if self == 0 { return defaultValue }
        return min(max(self, range.lowerBound), range.upperBound)
    }
}
