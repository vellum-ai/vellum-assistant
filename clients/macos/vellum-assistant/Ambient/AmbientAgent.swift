import Foundation
import AppKit
import Combine
import UserNotifications
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
    let knowledgeStore = KnowledgeStore()
    private var analyzer: AmbientAnalyzer?
    private var watchTask: Task<Void, Never>?
    private(set) var knowledgeCron: KnowledgeCron?
    private(set) var syncClient: AmbientSyncClient?
    private var syncTask: Task<Void, Never>?
    private var activeSuggestionWindow: AmbientSuggestionWindow?
    private var insightNotificationWindow: InsightNotificationWindow?
    private var previousAXText: String = ""
    private var previousOCRText: String = ""
    private var knowledgeCancellable: AnyCancellable?
    private var suggestionWindow: AmbientSuggestionWindow?
    private var cachedRejections: [RejectionEntry] = []
    private var localRejections: [RejectionEntry] = []
    private var lastRejectionFetchDate: Date?
    private let rejectionRefreshInterval: TimeInterval = 600

    weak var appDelegate: AppDelegate?

    var knowledge: KnowledgeStore { knowledgeStore }
    var insightStore: InsightStore? { knowledgeCron?.insightStore }

    init() {
        knowledgeCancellable = knowledgeStore.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
    }

    func start() {
        guard watchTask == nil else { return }
        guard let apiKey = APIKeyManager.getKey() else {
            log.warning("Cannot start ambient agent: no API key")
            return
        }

        analyzer = AmbientAnalyzer(apiKey: apiKey)
        state = .watching
        log.info("Ambient agent started (interval: \(self.captureIntervalSeconds)s)")

        let cron = KnowledgeCron(knowledgeStore: knowledgeStore)
        cron.onInsight = { [weak self] insight in
            self?.showInsightNotification(insight)
        }
        cron.start(apiKey: apiKey)
        knowledgeCron = cron

        // Remote sync
        let sync = AmbientSyncClient()
        syncClient = sync

        knowledgeStore.onEntryAdded = { [weak sync] entry in
            Task { await sync?.sendObservation(entry) }
        }
        cron.onInsightsAdded = { [weak sync] insights in
            Task { await sync?.sendInsights(insights) }
        }

        Task { [weak self] in
            await self?.refreshRejectionsIfNeeded()
        }

        syncTask = Task.detached { [weak self] in
            guard !Task.isCancelled else { return }
            let healthy = await sync.checkHealth()
            if healthy {
                log.info("Remote sync: healthy, uploading existing data")
            } else {
                log.warning("Remote sync: health check failed, will queue")
            }
            guard !Task.isCancelled else { return }
            guard let self else { return }
            await sync.syncExisting(
                observations: await self.knowledgeStore.entries,
                insights: await self.knowledgeCron?.insightStore.insights ?? []
            )
        }

        watchTask = Task { @MainActor [weak self] in
            await self?.watchLoop()
        }
    }

    func stop() {
        watchTask?.cancel()
        watchTask = nil
        syncTask?.cancel()
        syncTask = nil
        knowledgeCron?.stop()
        knowledgeCron = nil
        syncClient = nil
        knowledgeStore.onEntryAdded = nil
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

        state = .analyzing

        // Skip if frontmost app is Vellum itself to avoid self-referential observations
        let ownBundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == ownBundleId {
            log.debug("[\(cycle)] Frontmost app is self — skipping cycle")
            state = .watching
            return
        }

        // Try AX capture first
        let axStart = CFAbsoluteTimeGetCurrent()
        let snapshot = await AmbientAXCapture.capture()
        let axElapsed = CFAbsoluteTimeGetCurrent() - axStart

        var screenContent: String
        var captureMethod: String
        var appName: String
        var windowTitle: String
        var bundleIdentifier: String?
        var focusedElementDesc: String?

        if let snapshot, AmbientAXCapture.isUseful(snapshot), axElapsed < 0.5 {
            screenContent = AmbientAXCapture.format(snapshot)
            captureMethod = "ax-tree"
            appName = snapshot.focusedAppName
            windowTitle = snapshot.focusedWindowTitle
            bundleIdentifier = snapshot.focusedApp
            if let focused = snapshot.focusedElement {
                focusedElementDesc = focused.label.map { "\(focused.role) \"\($0)\"" } ?? focused.role
            }
        } else {
            // Fall back to screenshot + OCR
            if axElapsed >= 0.5 {
                log.warning("[\(cycle)] AX capture took \(String(format: "%.2f", axElapsed))s, using OCR fallback")
            } else if snapshot == nil {
                log.debug("[\(cycle)] AX capture returned nil, using OCR fallback")
            } else {
                log.debug("[\(cycle)] AX tree not useful (<3 elements), using OCR fallback")
            }

            let screenshot: Data
            do {
                screenshot = try await screenCapture.captureScreen()
            } catch {
                log.warning("[\(cycle)] Screenshot failed: \(error.localizedDescription)")
                state = .watching
                return
            }
            screenContent = await ocr.recognizeText(from: screenshot)
            captureMethod = "ocr"
            appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"
            windowTitle = currentWindowTitle() ?? "Unknown"
        }

        guard !screenContent.isEmpty else {
            log.debug("[\(cycle)] Screen content empty — skipping")
            state = .watching
            return
        }

        // Check similarity with previous capture of the same method
        let previousText = captureMethod == "ax-tree" ? previousAXText : previousOCRText
        let similarity = ScreenOCR.similarity(previousText, screenContent)
        if similarity > 0.85 {
            log.debug("[\(cycle)] Screen unchanged (similarity: \(String(format: "%.2f", similarity))) — skipping")
            state = .watching
            return
        }
        if captureMethod == "ax-tree" {
            previousAXText = screenContent
        } else {
            previousOCRText = screenContent
        }

        log.info("[\(cycle)] Analyzing \(appName) — \"\(windowTitle)\" (\(screenContent.count) chars, \(captureMethod))")

        // Send to Haiku
        guard let analyzer = analyzer else { return }

        let result: AmbientAnalysisResult
        do {
            result = try await analyzer.analyze(
                screenContent: screenContent,
                appName: appName,
                windowTitle: windowTitle,
                knowledgeContext: knowledgeStore.formattedContext(),
                captureMethod: captureMethod
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
            if let observation = result.observation, result.confidence > 0.5 {
                knowledgeStore.addEntry(
                    category: "observation",
                    observation: observation,
                    sourceApp: appName,
                    confidence: result.confidence,
                    windowTitle: windowTitle,
                    focusedElement: focusedElementDesc,
                    captureMethod: captureMethod,
                    bundleIdentifier: bundleIdentifier
                )
                knowledgeCron?.observationAdded()
            }

        case .suggest:
            if let suggestion = result.suggestion, result.confidence > 0.8 {
                await refreshRejectionsIfNeeded()
                if isSimilarToRejection(suggestion) {
                    log.info("[\(cycle)] Suggestion suppressed (similar to previous rejection): \(suggestion)")
                } else {
                    log.info("[\(cycle)] Suggestion: \(suggestion)")
                    lastSuggestion = suggestion
                    showSuggestion(suggestion)
                }
            } else {
                log.debug("[\(cycle)] Suggestion below confidence threshold (\(String(format: "%.2f", result.confidence)))")
            }
        }

        // Sync non-ignore analysis results and flush retry queue
        if result.decision != .ignore {
            await syncClient?.sendAnalysis(result)
        }
        await syncClient?.flushQueue()

        state = .watching
    }

    private func refreshRejectionsIfNeeded() async {
        if let lastFetch = lastRejectionFetchDate, Date().timeIntervalSince(lastFetch) < rejectionRefreshInterval {
            return
        }
        guard let syncClient else { return }
        if let fetched = await syncClient.fetchRejections() {
            // Remove local rejections that now appear on the server
            let fetchedTitles = Set(fetched.map(\.title))
            localRejections.removeAll { fetchedTitles.contains($0.title) }
            cachedRejections = fetched + localRejections
            lastRejectionFetchDate = Date()
        }
    }

    private func isSimilarToRejection(_ suggestion: String) -> Bool {
        for rejection in cachedRejections {
            if ScreenOCR.similarity(suggestion, rejection.title) > 0.5 ||
               ScreenOCR.similarity(suggestion, rejection.description) > 0.5 {
                return true
            }
        }
        return false
    }

    private func showSuggestion(_ suggestion: String) {
        guard let appDelegate = appDelegate else { return }
        let window = AmbientSuggestionWindow(
            suggestion: suggestion,
            onAccept: { [weak self] in
                self?.activeSuggestionWindow = nil
                self?.lastSuggestion = nil
                self?.suggestionWindow = nil
                appDelegate.startSession(task: suggestion)
            },
            onDismiss: { [weak self] in
                self?.activeSuggestionWindow = nil
                self?.lastSuggestion = nil
                self?.suggestionWindow = nil
                let decision = AutomationDecision(
                    insightId: "",
                    insightTitle: suggestion,
                    description: suggestion,
                    schedule: "",
                    approved: false,
                    reason: nil,
                    source: "alexs-macbook-pro-2"
                )
                Task { await self?.syncClient?.sendDecision(decision) }
                let entry = RejectionEntry(
                    insightId: "",
                    title: suggestion,
                    description: suggestion,
                    reason: nil,
                    source: "alexs-macbook-pro-2",
                    receivedAt: ISO8601DateFormatter().string(from: Date())
                )
                self?.cachedRejections.append(entry)
                self?.localRejections.append(entry)
            }
        )
        activeSuggestionWindow = window
        window.show()
        suggestionWindow = window
    }

    private func showInsightNotification(_ insight: KnowledgeInsight) {
        if insight.category == .automation && Bundle.main.bundleIdentifier != nil {
            showAutomationNotification(insight)
            return
        }

        let window = InsightNotificationWindow(
            insight: insight,
            onDismiss: { [weak self] in
                self?.insightNotificationWindow = nil
            },
            onViewAll: { [weak self] in
                self?.insightNotificationWindow = nil
                NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            }
        )
        insightNotificationWindow = window
        window.show()
    }

    private func showAutomationNotification(_ insight: KnowledgeInsight) {
        let content = UNMutableNotificationContent()
        content.title = "Automation Opportunity"
        content.body = insight.title
        content.categoryIdentifier = "AUTOMATION_INSIGHT"
        content.sound = .default
        content.userInfo = [
            "insightId": insight.id.uuidString,
            "insightTitle": insight.title,
            "insightDescription": insight.description
        ]

        let request = UNNotificationRequest(
            identifier: "automation-\(insight.id.uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                log.warning("Failed to deliver automation notification: \(error.localizedDescription)")
            }
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

private extension Double {
    func clamped(to range: ClosedRange<Double>, default defaultValue: Double) -> Double {
        if self == 0 { return defaultValue }
        return min(max(self, range.lowerBound), range.upperBound)
    }
}
