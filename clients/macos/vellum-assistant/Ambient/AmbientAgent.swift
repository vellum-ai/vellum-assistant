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
    var daemonClient: DaemonClient?
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
    private var lastRejectionFetchDate: Date?
    private let rejectionRefreshInterval: TimeInterval = 600
    private let rejectionFailureRetryInterval: TimeInterval = 60

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

        guard daemonClient != nil else {
            log.warning("Cannot start ambient agent: no daemon client")
            return
        }

        state = .watching
        log.info("Ambient agent started (interval: \(self.captureIntervalSeconds)s)")

        let cron = KnowledgeCron(knowledgeStore: knowledgeStore)
        cron.onInsight = { [weak self] insight in
            self?.showInsightNotification(insight)
        }
        if let apiKey = APIKeyManager.getKey() {
            cron.start(apiKey: apiKey)
        } else {
            log.warning("No API key for KnowledgeCron — insight analysis disabled")
        }
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

        // Send observation to daemon via IPC
        guard let daemonClient = daemonClient else {
            log.warning("[\(cycle)] No daemon client — skipping analysis")
            state = .watching
            return
        }

        do {
            try daemonClient.send(AmbientObservationMessage(
                ocrText: screenContent,
                appName: appName,
                windowTitle: windowTitle,
                timestamp: Date().timeIntervalSince1970 * 1000
            ))
        } catch {
            log.warning("[\(cycle)] Failed to send observation to daemon: \(error.localizedDescription)")
            state = .watching
            return
        }

        // Wait for ambient_result from daemon
        guard let ambientResult = await waitForAmbientResult(timeout: 30) else {
            log.warning("[\(cycle)] Timed out waiting for ambient result from daemon")
            state = .watching
            return
        }

        let decision = AmbientDecision(rawValue: ambientResult.decision)
        log.info("[\(cycle)] Decision: \(ambientResult.decision)")

        switch decision {
        case .ignore:
            break

        case .observe:
            if let observation = ambientResult.summary {
                knowledgeStore.addEntry(
                    category: "observation",
                    observation: observation,
                    sourceApp: appName,
                    confidence: 1.0,
                    windowTitle: windowTitle,
                    focusedElement: focusedElementDesc,
                    captureMethod: captureMethod,
                    bundleIdentifier: bundleIdentifier
                )
                knowledgeCron?.observationAdded()
            }

        case .suggest:
            if let suggestion = ambientResult.suggestion {
                await refreshRejectionsIfNeeded()
                if isSimilarToRejection(suggestion) {
                    log.info("[\(cycle)] Suggestion suppressed (similar to previous rejection): \(suggestion)")
                } else {
                    log.info("[\(cycle)] Suggestion: \(suggestion)")
                    lastSuggestion = suggestion
                    showSuggestion(suggestion)
                }
            }

        case .none:
            log.warning("[\(cycle)] Unknown decision from daemon: \(ambientResult.decision)")
        }

        // Sync non-ignore analysis results and flush retry queue
        if let decision, decision != .ignore {
            let result = AmbientAnalysisResult(
                decision: decision,
                observation: ambientResult.summary,
                suggestion: ambientResult.suggestion,
                confidence: 1.0,
                reasoning: ""
            )
            await syncClient?.sendAnalysis(result)
        }
        await syncClient?.flushQueue()

        state = .watching
    }

    private func waitForAmbientResult(timeout: TimeInterval = 30) async -> AmbientResultMessage? {
        guard let daemonClient = daemonClient else { return nil }
        let messageStream = daemonClient.subscribe()
        return await withTaskGroup(of: AmbientResultMessage?.self) { group in
            group.addTask {
                for await message in messageStream {
                    if case .ambientResult(let result) = message {
                        return result
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return nil
            }
            let result = await group.next() ?? nil
            group.cancelAll()
            return result
        }
    }

    private func refreshRejectionsIfNeeded() async {
        if let lastFetch = lastRejectionFetchDate, Date().timeIntervalSince(lastFetch) < rejectionRefreshInterval {
            return
        }
        guard let syncClient else { return }
        if let fetched = await syncClient.fetchRejections() {
            cachedRejections = fetched
            lastRejectionFetchDate = Date()
        } else {
            // Back off on failure to avoid hammering a flapping endpoint.
            // Use a shorter interval than the normal TTL so recovery is still prompt.
            lastRejectionFetchDate = Date().addingTimeInterval(-(rejectionRefreshInterval - rejectionFailureRetryInterval))
        }
    }

    private func isSimilarToRejection(_ suggestion: String) -> Bool {
        for rejection in cachedRejections {
            let rejectionText = "\(rejection.title) \(rejection.description)"
            if ScreenOCR.similarity(suggestion, rejectionText) > 0.5 {
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
                    source: ProcessInfo.processInfo.hostName
                )
                Task { await self?.syncClient?.sendDecision(decision) }
                self?.cachedRejections.append(RejectionEntry(
                    insightId: "",
                    title: suggestion,
                    description: suggestion,
                    reason: nil,
                    source: ProcessInfo.processInfo.hostName,
                    receivedAt: ISO8601DateFormatter().string(from: Date())
                ))
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
