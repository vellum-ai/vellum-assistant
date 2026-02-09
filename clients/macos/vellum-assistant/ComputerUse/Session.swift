import Foundation
import CoreGraphics
import AppKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "Session")

enum SessionState: Equatable {
    case idle
    case running(step: Int, maxSteps: Int, lastAction: String, reasoning: String)
    case paused(step: Int, maxSteps: Int)
    case awaitingConfirmation(reason: String)
    case completed(summary: String, steps: Int)
    case failed(reason: String)
    case cancelled
}

@MainActor
final class ComputerUseSession: ObservableObject {
    @Published var state: SessionState = .idle

    let task: String
    private let provider: ActionInferenceProvider
    private let maxSteps: Int
    private let stepDelayMs: UInt64

    private var actionHistory: [ActionRecord] = []
    private var isCancelled = false
    private var isPaused = false
    private var confirmationContinuation: CheckedContinuation<Bool, Never>?

    private let enumerator: AccessibilityTreeProviding
    private let screenCapture: ScreenCaptureProviding
    private let executor: ActionExecuting
    private let verifier: ActionVerifier
    private let logger: SessionLogger
    private let initialDelayMs: UInt64
    private var didChromeAccessibilityCheck = false
    private var previousAXTreeText: String?
    private var previousElements: [AXElement]?
    private var previousFlatElements: [AXElement]?
    private var consecutiveUnchangedSteps = 0

    /// Adaptive delay configuration
    private let adaptiveDelayEnabled: Bool
    private let minDelayMs: UInt64 = 100
    private let maxDelayMs: UInt64 = 2000
    private let pollIntervalMs: UInt64 = 50

    init(
        task: String,
        provider: ActionInferenceProvider,
        enumerator: AccessibilityTreeProviding = AccessibilityTreeEnumerator(),
        screenCapture: ScreenCaptureProviding = ScreenCapture(),
        executor: ActionExecuting = ActionExecutor(),
        maxSteps: Int = 50,
        stepDelayMs: UInt64 = 500,
        initialDelayMs: UInt64 = 300,
        adaptiveDelay: Bool = true
    ) {
        self.task = task
        self.provider = provider
        self.enumerator = enumerator
        self.screenCapture = screenCapture
        self.executor = executor
        self.maxSteps = maxSteps
        self.stepDelayMs = stepDelayMs
        self.initialDelayMs = initialDelayMs
        self.adaptiveDelayEnabled = adaptiveDelay
        self.verifier = ActionVerifier(maxSteps: maxSteps)
        self.logger = SessionLogger(task: task)
    }

    func run() async {
        actionHistory.removeAll()
        verifier.reset()
        isCancelled = false
        isPaused = false
        previousAXTreeText = nil
        previousElements = nil
        previousFlatElements = nil
        consecutiveUnchangedSteps = 0
        state = .running(step: 0, maxSteps: maxSteps, lastAction: "Starting...", reasoning: "")

        log.info("Session starting — task: \(self.task, privacy: .public)")
        log.info("Screen size: \(Int(self.screenCapture.screenSize().width))×\(Int(self.screenCapture.screenSize().height))")

        // Brief delay to let the popover close and the target app regain focus
        if initialDelayMs > 0 {
            try? await Task.sleep(nanoseconds: initialDelayMs * 1_000_000)
        }

        while !isCancelled {
            // Wait while paused
            while isPaused && !isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
            }
            if isCancelled { break }

            let stepNumber = actionHistory.count + 1

            // 1. PERCEIVE — always prefer accessibility tree
            var axTreeText: String?
            var elements: [AXElement]?
            var flatElements: [AXElement]?
            var screenshot: Data?
            var usedVision = false
            var axDiffText: String?
            var secondaryWindowsText: String?
            var primaryPID: pid_t?
            var currentAppName: String?

            if let result = enumerator.enumerateCurrentWindow() {
                // On first step with Chrome: check if web content is visible.
                // If not, restart Chrome with --force-renderer-accessibility and re-enumerate.
                if !didChromeAccessibilityCheck,
                   let frontApp = NSWorkspace.shared.frontmostApplication,
                   ChromeAccessibilityHelper.isChromium(frontApp),
                   !ChromeAccessibilityHelper.hasWebContent(elements: result.elements) {
                    didChromeAccessibilityCheck = true
                    log.warning("Chrome detected but AX tree has no web content — restarting with accessibility")
                    state = .running(step: 0, maxSteps: maxSteps, lastAction: "Enabling Chrome accessibility...", reasoning: "")
                    let restarted = await ChromeAccessibilityHelper.restartChromeWithAccessibility(app: frontApp)
                    if restarted {
                        // Clear the enhanced-AX cache so we re-set it on the new process
                        AccessibilityTreeEnumerator.clearEnhancedAXCache()
                        log.info("Chrome restarted — re-enumerating")
                        continue // re-run the PERCEIVE step
                    } else {
                        log.error("Chrome restart failed — continuing with limited AX tree")
                    }
                }
                didChromeAccessibilityCheck = true

                // Always use the AX tree when we have a focused window
                axTreeText = AccessibilityTreeEnumerator.formatAXTree(
                    elements: result.elements,
                    windowTitle: result.windowTitle,
                    appName: result.appName
                )
                elements = result.elements
                currentAppName = result.appName
                let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
                flatElements = flat
                let interactiveCount = flat.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
                log.info("[\(stepNumber)] AX tree: \(result.appName) — \"\(result.windowTitle)\" — \(flat.count) elements (\(interactiveCount) interactive)")
                log.debug("[\(stepNumber)] AX tree text:\n\(axTreeText ?? "(empty)")")

                // Compute AX tree diff if we have a previous snapshot (using pre-flattened arrays)
                if let prevFlat = previousFlatElements {
                    axDiffText = AXTreeDiff.diff(previousFlat: prevFlat, currentFlat: flat)
                    if let diff = axDiffText {
                        log.info("[\(stepNumber)] AX diff:\n\(diff)")
                        consecutiveUnchangedSteps = 0
                    } else {
                        consecutiveUnchangedSteps += 1
                        log.info("[\(stepNumber)] AX tree unchanged from previous step (consecutive: \(self.consecutiveUnchangedSteps))")
                    }
                }

                // Use the actual enumerated app's PID (not frontmostApplication,
                // which may be our own app when we fell back to enumeratePreviousApp)
                primaryPID = result.pid

                // Enumerate secondary windows for cross-app awareness
                let secondaryWindows = enumerator.enumerateSecondaryWindows(
                    excludingPID: primaryPID,
                    maxWindows: 2
                )
                secondaryWindowsText = AccessibilityTreeEnumerator.formatSecondaryWindows(secondaryWindows)
                if let secText = secondaryWindowsText {
                    log.info("[\(stepNumber)] Secondary windows: \(secondaryWindows.count)")
                    log.debug("[\(stepNumber)] Secondary windows text:\n\(secText)")
                }

                // Conditionally capture a screenshot — skip on middle steps when AX tree is sufficient
                let lastAction = actionHistory.last?.action
                if shouldCaptureScreenshot(stepNumber: stepNumber, flatElements: flat, lastAction: lastAction) {
                    do {
                        screenshot = try await screenCapture.captureScreen()
                        log.info("[\(stepNumber)] Screenshot captured alongside AX tree (\(screenshot?.count ?? 0) bytes)")
                    } catch {
                        log.warning("[\(stepNumber)] Screenshot capture failed alongside AX tree: \(error.localizedDescription)")
                        // Non-fatal — we still have the AX tree
                    }
                } else {
                    log.debug("[\(stepNumber)] Screenshot skipped — AX tree is sufficient")
                }
            } else {
                // No focused window — try screenshot as last resort
                log.warning("[\(stepNumber)] No AX tree available — falling back to screenshot")
                do {
                    screenshot = try await screenCapture.captureScreen()
                    usedVision = true
                    log.info("[\(stepNumber)] Screenshot captured (\(screenshot?.count ?? 0) bytes)")
                } catch {
                    log.error("[\(stepNumber)] Screen capture failed: \(error.localizedDescription)")
                    state = .failed(reason: "No focused window and screen capture failed")
                    logger.finishSession(result: "failed: no window")
                    return
                }
            }

            // 2. INFER
            let action: AgentAction
            let tokenUsage: TokenUsage?
            do {
                let result = try await provider.infer(
                    axTree: axTreeText,
                    previousAXTree: previousAXTreeText,
                    axDiff: axDiffText,
                    secondaryWindows: secondaryWindowsText,
                    screenshot: screenshot,
                    screenSize: screenCapture.screenSize(),
                    task: task,
                    history: actionHistory,
                    elements: flatElements,
                    consecutiveUnchangedSteps: consecutiveUnchangedSteps
                )
                action = result.action
                tokenUsage = result.usage
            } catch {
                log.error("[\(stepNumber)] Inference error: \(error.localizedDescription)")
                state = .failed(reason: "Inference failed: \(error.localizedDescription)")
                logger.finishSession(result: "failed: inference error")
                return
            }

            log.info("[\(stepNumber)] Model action: \(action.displayDescription) — reasoning: \(action.reasoning)")
            if let usage = tokenUsage {
                log.info("[\(stepNumber)] Tokens — input: \(usage.inputTokens), output: \(usage.outputTokens)")
            }
            logger.logTurn(step: stepNumber, axTree: axTreeText, screenshot: screenshot, action: action, usedVision: usedVision, usage: tokenUsage)

            // 3. CHECK COMPLETION
            if action.type == .done {
                let summary = action.summary ?? "Task completed"
                let record = ActionRecord(step: stepNumber, action: action, result: "executed", timestamp: Date())
                actionHistory.append(record)
                state = .completed(summary: summary, steps: stepNumber)
                logger.finishSession(result: "completed: \(summary)")
                return
            }

            // 4. VERIFY
            let verifyResult = verifier.verify(action)
            switch verifyResult {
            case .allowed:
                verifier.resetBlockCount()

            case .needsConfirmation(let reason):
                state = .awaitingConfirmation(reason: reason)
                let approved = await withCheckedContinuation { continuation in
                    confirmationContinuation = continuation
                }
                confirmationContinuation = nil

                if !approved {
                    state = .cancelled
                    logger.finishSession(result: "cancelled: user rejected confirmation")
                    return
                }
                verifier.recordConfirmedAction(action)
                state = .running(step: stepNumber, maxSteps: maxSteps, lastAction: action.displayDescription, reasoning: action.reasoning)

            case .blocked(let reason):
                log.warning("[\(stepNumber)] BLOCKED: \(reason)")
                let record = ActionRecord(step: stepNumber, action: action, result: "BLOCKED: \(reason)", timestamp: Date())
                actionHistory.append(record)
                verifier.recordBlock()
                if verifier.consecutiveBlockCount >= 3 {
                    state = .failed(reason: "Session stopped: 3 consecutive actions blocked")
                    logger.finishSession(result: "failed: too many blocks")
                    return
                }
                continue
            }

            // 4.5. NO-OP DETECTION — skip execution for actions that would have no effect
            if let noOpReason = detectNoOp(action, currentAppName: currentAppName) {
                log.info("[\(stepNumber)] NO-OP: \(noOpReason)")
                let record = ActionRecord(step: stepNumber, action: action, result: "NO-OP: \(noOpReason). What action would you like to take?", timestamp: Date())
                actionHistory.append(record)
                state = .running(step: stepNumber, maxSteps: maxSteps, lastAction: "\(action.displayDescription) (skipped)", reasoning: action.reasoning)
                previousAXTreeText = axTreeText
                previousElements = elements
                previousFlatElements = flatElements
                continue
            }

            // 5. EXECUTE
            let executionResult: String?
            do {
                executionResult = try await executor.execute(action)
            } catch {
                let errorMessage = error.localizedDescription
                let record = ActionRecord(step: stepNumber, action: action, result: "ERROR: \(errorMessage)", timestamp: Date())
                actionHistory.append(record)

                // AppleScript errors are non-fatal — let the model adapt
                if action.type == .runAppleScript {
                    log.warning("[\(stepNumber)] AppleScript error (non-fatal): \(errorMessage)")
                    state = .running(step: stepNumber, maxSteps: maxSteps, lastAction: "\(action.displayDescription) (error)", reasoning: action.reasoning)
                    previousAXTreeText = axTreeText
                    previousElements = elements
                    previousFlatElements = flatElements
                    continue
                }

                state = .failed(reason: "Execution failed: \(errorMessage)")
                logger.finishSession(result: "failed: execution error")
                return
            }

            // Format result string, including AppleScript output when present
            let resultString: String
            if let output = executionResult {
                let truncated = output.count > 500 ? String(output.prefix(500)) + "..." : output
                resultString = "executed (result: \(truncated))"
            } else {
                resultString = "executed"
            }

            let record = ActionRecord(step: stepNumber, action: action, result: resultString, timestamp: Date())
            actionHistory.append(record)

            // 6. UPDATE UI
            state = .running(step: stepNumber, maxSteps: maxSteps, lastAction: action.displayDescription, reasoning: action.reasoning)

            // Save current AX tree for next step's context
            previousAXTreeText = axTreeText
            previousElements = elements
            previousFlatElements = flatElements

            // 7. WAIT — adaptive delay: poll for AX tree changes instead of fixed sleep
            if adaptiveDelayEnabled && axTreeText != nil {
                await waitForUISettle(previousTree: axTreeText)
            } else {
                try? await Task.sleep(nanoseconds: stepDelayMs * 1_000_000)
            }
        }

        // Cancelled
        state = .cancelled
        logger.finishSession(result: "cancelled")
    }

    // MARK: - Adaptive Delay

    /// Poll the AX tree until it changes or stabilizes.
    /// Returns early when:
    /// 1. The tree differs from `previousTree` (action took effect)
    /// 2. The tree has been identical for `stableExitThreshold` consecutive polls (UI is stable)
    /// 3. `maxPollCount` polls are exhausted
    /// 4. `maxDelayMs` timeout is reached
    private func waitForUISettle(previousTree: String?) async {
        // Always wait the minimum delay to let CGEvents propagate
        try? await Task.sleep(nanoseconds: minDelayMs * 1_000_000)

        var elapsed = minDelayMs
        var consecutiveStablePolls = 0
        var lastPollTree: String? = previousTree
        var pollCount = 0
        let maxPollCount = 10
        let stableExitThreshold = 3
        var hasChangedFromPrevious = false

        while elapsed < maxDelayMs && !isCancelled && pollCount < maxPollCount {
            // Quick check if the AX tree has changed
            if let result = enumerator.enumerateCurrentWindow() {
                let currentTree = AccessibilityTreeEnumerator.formatAXTree(
                    elements: result.elements,
                    windowTitle: result.windowTitle,
                    appName: result.appName
                )

                // Exit: tree changed from pre-action state (action took effect)
                if currentTree != previousTree {
                    hasChangedFromPrevious = true
                    log.debug("UI settled after \(elapsed)ms (tree changed)")
                    return
                }

                // Track consecutive identical polls for early stability exit,
                // but ONLY use this shortcut after we've seen the tree change
                // at least once. Otherwise slow UI updates (app launches,
                // delayed renders) get declared "stable" prematurely.
                if currentTree == lastPollTree {
                    consecutiveStablePolls += 1
                } else {
                    consecutiveStablePolls = 0
                }
                lastPollTree = currentTree

                if hasChangedFromPrevious && consecutiveStablePolls >= stableExitThreshold {
                    log.debug("UI stable after \(elapsed)ms (\(consecutiveStablePolls) identical polls after change)")
                    return
                }
            }

            try? await Task.sleep(nanoseconds: pollIntervalMs * 1_000_000)
            elapsed += pollIntervalMs
            pollCount += 1
        }

        log.debug("UI settle timeout after \(elapsed)ms (polls: \(pollCount))")
    }

    // MARK: - Conditional Screenshot

    /// Decide whether to capture a screenshot alongside the AX tree.
    /// Skips on middle steps when the AX tree provides sufficient context.
    private func shouldCaptureScreenshot(stepNumber: Int, flatElements: [AXElement], lastAction: AgentAction?) -> Bool {
        // Always capture on step 1 (model needs full visual context to start)
        if stepNumber == 1 { return true }

        // Capture after openApp (visual context for new app)
        if lastAction?.type == .openApp { return true }

        // Capture when AX tree is too sparse to be useful (< 3 interactive elements)
        let interactiveCount = flatElements.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
        if interactiveCount < 3 { return true }

        // Capture when UI appears stuck (model may need visual clues to break out)
        if consecutiveUnchangedSteps >= 2 { return true }

        // AX tree is sufficient — skip screenshot
        return false
    }

    // MARK: - No-Op Detection

    /// Detect if an action would be a no-op (e.g., opening an app that's already frontmost).
    /// Returns a human-readable reason if no-op, nil if the action should proceed normally.
    private func detectNoOp(_ action: AgentAction, currentAppName: String?) -> String? {
        guard action.type == .openApp,
              let requestedApp = action.appName,
              let currentApp = currentAppName else {
            return nil
        }

        let requestedLower = requestedApp.lowercased()
        let currentLower = currentApp.lowercased()

        // Direct name match
        if requestedLower == currentLower {
            return "\(currentApp) is already the frontmost app"
        }

        // Alias match (e.g., "chrome" → "Google Chrome")
        if let resolvedName = ActionExecutor.appAliases[requestedLower],
           resolvedName.lowercased() == currentLower {
            return "\(currentApp) is already the frontmost app"
        }

        return nil
    }

    // MARK: - Control

    func pause() {
        isPaused = true
        let step = actionHistory.count
        state = .paused(step: step, maxSteps: maxSteps)
    }

    func resume() {
        isPaused = false
    }

    func cancel() {
        isCancelled = true
        confirmationContinuation?.resume(returning: false)
        confirmationContinuation = nil
    }

    func approveConfirmation() {
        confirmationContinuation?.resume(returning: true)
    }

    func rejectConfirmation() {
        confirmationContinuation?.resume(returning: false)
    }
}
