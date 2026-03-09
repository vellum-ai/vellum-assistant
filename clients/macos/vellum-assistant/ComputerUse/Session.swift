import Foundation
import VellumAssistantShared
import CoreGraphics
import AppKit
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "Session")

enum SessionState: Equatable {
    case idle
    case running(step: Int, maxSteps: Int, lastAction: String, reasoning: String)
    case thinking(step: Int, maxSteps: Int)
    case paused(step: Int, maxSteps: Int)
    case awaitingConfirmation(reason: String)
    case completed(summary: String, steps: Int)
    case responded(answer: String, steps: Int)
    case failed(reason: String)
    case cancelled
}

@MainActor
final class ComputerUseSession: ObservableObject {
    @Published var state: SessionState = .idle
    @Published var undoCount = 0
    @Published var autoApproveTools = false
    /// Free-form guidance from the user, consumed on the next observation.
    @Published var pendingUserGuidance: String?

    let task: String
    let id: String

    private let attachments: [TaskAttachment]
    private let daemonClient: DaemonClientProtocol
    private let maxSteps: Int
    private let interactionType: InteractionType
    private let skipSessionCreate: Bool
    private let notificationService: ActivityNotificationServiceProtocol?

    /// Weak reference to the chat view model for extracting tool calls for notifications.
    weak var relatedViewModel: ChatViewModel?

    private var isCancelled = false
    private var isPaused = false
    private var confirmationContinuation: CheckedContinuation<Bool, Never>?
    private var messageLoopTask: Task<Void, Never>?

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
    private var currentStepNumber = 0

    /// Adaptive delay configuration
    private let adaptiveDelayEnabled: Bool
    private let minDelayMs: UInt64 = 100
    private let maxDelayMs: UInt64 = 1200
    private let pollIntervalMs: UInt64 = 100

    init(
        task: String,
        daemonClient: DaemonClientProtocol,
        enumerator: AccessibilityTreeProviding = AccessibilityTreeEnumerator(),
        screenCapture: ScreenCaptureProviding = ScreenCapture(),
        executor: ActionExecuting = ActionExecutor(),
        maxSteps: Int = 50,
        attachments: [TaskAttachment] = [],
        interactionType: InteractionType = .computerUse,
        initialDelayMs: UInt64 = 300,
        adaptiveDelay: Bool = true,
        sessionId: String? = nil,
        skipSessionCreate: Bool = false,
        notificationService: ActivityNotificationServiceProtocol? = nil
    ) {
        self.id = sessionId ?? UUID().uuidString
        self.task = task
        self.attachments = attachments
        self.daemonClient = daemonClient
        self.interactionType = interactionType
        self.enumerator = enumerator
        self.screenCapture = screenCapture
        self.executor = executor
        self.maxSteps = maxSteps
        self.initialDelayMs = initialDelayMs
        self.adaptiveDelayEnabled = adaptiveDelay
        self.skipSessionCreate = skipSessionCreate
        self.notificationService = notificationService
        self.verifier = ActionVerifier(maxSteps: maxSteps)
        self.logger = SessionLogger(task: task, attachments: attachments)
    }

    func run() async {
        verifier.reset()
        isCancelled = false
        isPaused = false
        previousAXTreeText = nil
        previousElements = nil
        previousFlatElements = nil
        consecutiveUnchangedSteps = 0
        currentStepNumber = 0
        state = .running(step: 0, maxSteps: maxSteps, lastAction: "Starting...", reasoning: "")

        log.info("Session starting — task: \(self.task, privacy: .public)")

        let screenSize = screenCapture.screenSize()
        log.info("Screen size: \(Int(screenSize.width))x\(Int(screenSize.height))")

        // Brief delay to let the popover close and the target app regain focus
        if initialDelayMs > 0 {
            do {
                try await Task.sleep(nanoseconds: initialDelayMs * 1_000_000)
            } catch {
                log.warning("Initial delay interrupted: \(error)")
            }
        }

        // 1. Subscribe before sending so we don't miss fast daemon responses
        let messageStream = daemonClient.subscribe()

        // 2. Send session create message (skip if daemon already created via task_submit)
        if !skipSessionCreate {
            let ipcAttachments: [IPCAttachment]? = attachments.isEmpty ? nil : attachments.map {
                IPCAttachment(
                    filename: $0.fileName,
                    mimeType: $0.mimeType,
                    data: $0.data.base64EncodedString(),
                    extractedText: $0.extractedText
                )
            }
            let interactionTypeString: String = switch interactionType {
            case .computerUse: "computer_use"
            case .textQA: "text_qa"
            }
            do {
                try daemonClient.send(CuSessionCreateMessage(
                    sessionId: id,
                    task: task,
                    screenWidth: Int(screenSize.width),
                    screenHeight: Int(screenSize.height),
                    attachments: ipcAttachments,
                    interactionType: interactionTypeString
                ))
            } catch {
                log.error("Failed to send session create message: \(error)")
            }
        }

        // 3. Initial perceive + send first observation
        let obs = await buildObservation(executionResult: nil, executionError: nil)
        if let obs {
            do {
                try daemonClient.send(obs)
            } catch {
                log.error("Failed to send initial observation: \(error)")
            }
        } else {
            state = .failed(reason: "No focused window and screen capture failed")
            do {
                try daemonClient.send(CuSessionAbortMessage(sessionId: id))
            } catch {
                log.error("Failed to send session abort message: \(error)")
            }
            logger.finishSession(result: "failed: no window")
            return
        }

        state = .thinking(step: 1, maxSteps: maxSteps)

        // 4. Listen for daemon messages (filter by sessionId)
        // Wrap in a cancellable task so cancel() can interrupt the stream await.
        let loopTask = Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in messageStream {
                guard !self.isCancelled else { break }

                // Wait while paused
                while self.isPaused && !self.isCancelled {
                    do {
                        try await Task.sleep(nanoseconds: 100_000_000) // 100ms
                    } catch {
                        log.warning("Pause poll sleep interrupted: \(error)")
                        break
                    }
                }
                if self.isCancelled { break }

                switch message {
                case .cuAction(let action) where action.sessionId == self.id:
                    await self.handleAction(action)
                    // Check if handleAction set a terminal state
                    if self.isCancelled { return }

                case .cuComplete(let complete) where complete.sessionId == self.id:
                    if complete.isResponse == true {
                        self.state = .responded(answer: complete.summary, steps: complete.stepCount)
                    } else {
                        self.state = .completed(summary: complete.summary, steps: complete.stepCount)
                    }
                    self.logger.finishSession(result: "completed: \(complete.summary)")
                    log.info("Session completed, notificationService present: \(self.notificationService != nil)")

                    // Send notification if service is available
                    if let notificationService = self.notificationService {
                        log.info("Calling notificationService.notifySessionComplete")
                        let toolCalls = self.extractToolCalls()
                        Task {
                            await notificationService.notifySessionComplete(
                                summary: complete.summary,
                                steps: complete.stepCount,
                                toolCalls: toolCalls,
                                sessionId: self.id
                            )
                        }
                    } else {
                        log.warning("notificationService is nil, cannot send notification")
                    }

                    return

                case .cuError(let error) where error.sessionId == self.id:
                    self.state = .failed(reason: error.message)
                    self.logger.finishSession(result: "failed: \(error.message)")
                    return

                case .sessionError(let error) where error.sessionId == self.id:
                    self.state = .failed(reason: error.userMessage)
                    self.logger.finishSession(result: "failed: \(error.userMessage)")
                    return

                default:
                    break // ignore messages for other sessions
                }
            }
        }
        messageLoopTask = loopTask
        await loopTask.value

        // Stream ended or cancelled — ensure terminal state is set
        switch state {
        case .completed, .responded, .failed, .cancelled:
            break // already in terminal state
        default:
            if isCancelled {
                state = .cancelled
                logger.finishSession(result: "cancelled")
            } else {
                state = .failed(reason: "Connection to daemon lost")
                logger.finishSession(result: "failed: stream ended unexpectedly")
            }
        }
    }

    // MARK: - Action Handler

    private func handleAction(_ action: CuActionMessage) async {
        var agentAction = mapToAgentAction(action)
        currentStepNumber = action.stepNumber

        guard let resolved = await resolveCoordinatesIfNeeded(for: agentAction, stepNumber: action.stepNumber) else {
            return
        }
        agentAction = resolved

        // Update state for UI
        state = .running(
            step: action.stepNumber,
            maxSteps: maxSteps,
            lastAction: agentAction.displayDescription,
            reasoning: action.reasoning ?? ""
        )

        // Log the step
        logger.logTurn(
            step: action.stepNumber,
            axTree: previousAXTreeText,
            screenshot: nil,
            action: agentAction,
            usedVision: false
        )

        log.info("[\(action.stepNumber)] Daemon action: \(agentAction.displayDescription) — reasoning: \(action.reasoning ?? "")")

        // Handle done/respond completion actions — don't execute, wait for cu_complete
        if agentAction.type == .done || agentAction.type == .respond {
            return
        }

        // VERIFY (local safety check)
        let verifyResult = verifier.verify(agentAction)
        var primaryPID: pid_t?

        switch verifyResult {
        case .allowed:
            verifier.resetBlockCount()

        case .needsConfirmation(let reason):
            // Auto-approve only low-risk confirmations (AppleScript).
            // Destructive keys and form submissions (Enter) always prompt.
            let isLowRisk = agentAction.type == .runAppleScript
            if autoApproveTools && isLowRisk {
                log.info("[\(action.stepNumber)] Auto-approved: \(reason)")
                verifier.recordConfirmedAction(agentAction)
                verifier.resetBlockCount()
                break
            }

            // Capture the PID before showing confirmation UI
            if let result = enumerator.enumerateCurrentWindow() {
                primaryPID = result.pid
            }

            state = .awaitingConfirmation(reason: reason)
            let approved = await withCheckedContinuation { continuation in
                confirmationContinuation = continuation
            }
            confirmationContinuation = nil

            if !approved {
                isCancelled = true
                state = .cancelled
                logger.finishSession(result: "cancelled: user rejected confirmation")
                return
            }
            verifier.recordConfirmedAction(agentAction)
            state = .running(
                step: action.stepNumber,
                maxSteps: maxSteps,
                lastAction: agentAction.displayDescription,
                reasoning: action.reasoning ?? ""
            )

            // Re-activate the target app after the confirmation panel interaction
            if let pid = primaryPID,
               let app = NSRunningApplication(processIdentifier: pid) {
                app.activate()
                do {
                    try await Task.sleep(nanoseconds: 200_000_000) // 200ms for focus to settle
                } catch {
                    log.warning("Post-confirmation focus settle delay interrupted: \(error)")
                }
            }

        case .blocked(let reason):
            log.warning("[\(action.stepNumber)] BLOCKED: \(reason)")
            verifier.recordBlock()
            if verifier.consecutiveBlockCount >= 3 {
                isCancelled = true
                state = .failed(reason: "Session stopped: 3 consecutive actions blocked")
                logger.finishSession(result: "failed: too many blocks")
                return
            }
            // Send observation with block error so daemon can adapt
            let obs = await buildObservation(executionResult: nil, executionError: "BLOCKED: \(reason)")
            if let obs {
                do {
                    try daemonClient.send(obs)
                } catch {
                    log.error("Failed to send blocked observation: \(error)")
                }
            }
            state = .thinking(step: action.stepNumber + 1, maxSteps: maxSteps)
            return
        }

        // EXECUTE
        var executionResult: String? = nil
        var executionError: String? = nil
        do {
            executionResult = try await executor.execute(agentAction)
        } catch {
            let errorMessage = error.localizedDescription

            // AppleScript errors are non-fatal — let the daemon adapt
            if agentAction.type == .runAppleScript {
                log.warning("[\(action.stepNumber)] AppleScript error (non-fatal): \(errorMessage)")
                executionError = errorMessage
            } else {
                executionError = errorMessage
            }
        }

        // Format result string for logging
        if let output = executionResult {
            let truncated = output.count > 500 ? String(output.prefix(500)) + "..." : output
            log.info("[\(action.stepNumber)] Execution result: \(truncated)")
        }

        // WAIT — adaptive delay: poll for AX tree changes instead of fixed sleep
        if adaptiveDelayEnabled && previousAXTreeText != nil {
            let prevHash = previousFlatElements.map { Self.fastElementHash($0) } ?? 0
            await waitForUISettle(previousTree: previousAXTreeText, previousHash: prevHash)
        } else if adaptiveDelayEnabled {
            // Small delay for first step or when no previous tree
            do {
                try await Task.sleep(nanoseconds: 300_000_000) // 300ms
            } catch {
                log.warning("First-step delay interrupted: \(error)")
            }
        }

        // PERCEIVE + send next observation
        let obs = await buildObservation(executionResult: executionResult, executionError: executionError)
        if let obs {
            do {
                try daemonClient.send(obs)
            } catch {
                log.error("Failed to send observation after action execution: \(error)")
            }
        }

        state = .thinking(step: action.stepNumber + 1, maxSteps: maxSteps)
    }

    // MARK: - Observation Builder

    private func buildObservation(executionResult: String?, executionError: String?) async -> CuObservationMessage? {
        var axTreeText: String?
        var elements: [AXElement]?
        var flatElements: [AXElement]?
        var screenshotData: Data?
        var screenshotMetadata: ScreenCaptureMetadata?
        var axDiffText: String?
        var secondaryWindowsText: String?
        var primaryPID: pid_t?

        let stepNumber = currentStepNumber + 1

        func captureScreenshot() async -> ScreenCaptureResult? {
            do {
                // Keep CU observations lighter to avoid renderer/WindowServer churn
                // on complex pages while still preserving enough visual fidelity.
                return try await self.screenCapture.captureScreenWithMetadata(maxWidth: 960, maxHeight: 540)
            } catch {
                log.error("Screenshot capture failed: \(error)")
                return nil
            }
        }

        if let result = enumerator.enumerateCurrentWindow() {
            // On first step with Chrome: check if web content is visible.
            if !didChromeAccessibilityCheck,
               let frontApp = NSWorkspace.shared.frontmostApplication,
               ChromeAccessibilityHelper.isChromium(frontApp),
               !ChromeAccessibilityHelper.hasWebContent(elements: result.elements) {
                didChromeAccessibilityCheck = true
                let browserName = frontApp.localizedName ?? "Chrome"
                log.warning("\(browserName) detected but AX tree has no web content — needs restart with accessibility")

                // Ask the user before restarting — they may have unsaved work
                let alert = NSAlert()
                alert.messageText = "Restart \(browserName)?"
                alert.informativeText = "\(browserName) needs to restart with accessibility enabled for computer-use to work. You may lose unsaved form data. Continue?"
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Restart \(browserName)")
                alert.addButton(withTitle: "Cancel")
                NSApp.activate(ignoringOtherApps: true)
                let response = alert.runModal()

                if response == .alertFirstButtonReturn {
                    let restarted = await ChromeAccessibilityHelper.restartChromeWithFlags(app: frontApp, flags: ["--force-renderer-accessibility"])
                    if restarted {
                        AccessibilityTreeEnumerator.clearEnhancedAXCache()
                        log.info("\(browserName) restarted — re-enumerating")
                        return await buildObservation(executionResult: executionResult, executionError: executionError)
                    } else {
                        log.error("\(browserName) restart failed — continuing with limited AX tree")
                        // frontApp was terminated, so activate whatever is currently frontmost
                        if let currentFront = NSWorkspace.shared.frontmostApplication {
                            currentFront.activate()
                        }
                    }
                } else {
                    log.info("User declined \(browserName) restart — continuing with limited AX tree")
                    // Reactivate the original app so subsequent HID events target the correct window
                    frontApp.activate()
                }
            }
            didChromeAccessibilityCheck = true

            axTreeText = AccessibilityTreeEnumerator.formatAXTree(
                elements: result.elements,
                windowTitle: result.windowTitle,
                appName: result.appName
            )
            elements = result.elements
            let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
            flatElements = flat
            let interactiveCount = flat.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
            log.info("[\(stepNumber)] AX tree: \(result.appName) — \"\(result.windowTitle)\" — \(flat.count) elements (\(interactiveCount) interactive)")

            // Compute AX tree diff
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

            primaryPID = result.pid

            // Enumerate secondary windows
            if shouldEnumerateSecondaryWindows(stepNumber: stepNumber, lastAction: nil) {
                let secondaryWindows = enumerator.enumerateSecondaryWindows(
                    excludingPID: primaryPID,
                    maxWindows: 2
                )
                secondaryWindowsText = AccessibilityTreeEnumerator.formatSecondaryWindows(secondaryWindows)
                if let secText = secondaryWindowsText {
                    log.info("[\(stepNumber)] Secondary windows: \(secondaryWindows.count)")
                    log.debug("[\(stepNumber)] Secondary windows text:\n\(secText)")
                }
            }

            // Await the pre-started screenshot if we need it; cancel otherwise
            if shouldCaptureScreenshot(stepNumber: stepNumber, flatElements: flat, lastAction: nil) {
                let screenshotResult = await captureScreenshot()
                screenshotData = screenshotResult?.jpegData
                screenshotMetadata = screenshotResult?.metadata
                log.info("[\(stepNumber)] Screenshot captured alongside AX tree (\(screenshotData?.count ?? 0) bytes)")
            }
        } else {
            // No focused window — capture screenshot as last resort
            log.warning("[\(stepNumber)] No AX tree available — falling back to screenshot")
            let screenshotResult = await captureScreenshot()
            screenshotData = screenshotResult?.jpegData
            screenshotMetadata = screenshotResult?.metadata
            if screenshotData != nil {
                log.info("[\(stepNumber)] Screenshot captured (\(screenshotData?.count ?? 0) bytes)")
            } else {
                log.error("[\(stepNumber)] Screen capture failed")
                return nil
            }
        }

        // Save current AX tree for next step's context
        previousAXTreeText = axTreeText
        previousElements = elements
        previousFlatElements = flatElements

        // Encode screenshot as inline base64
        var screenshotBase64: String?

        if let screenshotBytes = screenshotData {
            screenshotBase64 = screenshotBytes.base64EncodedString()
        }

        let screenSizePt = screenshotData != nil ? screenCapture.screenSize() : nil

        let axTreeInline = axTreeText

        // Drain any pending user guidance so it's included in this observation
        let guidance = pendingUserGuidance
        pendingUserGuidance = nil

        let observation = CuObservationMessage(
            sessionId: id,
            axTree: axTreeInline,
            axDiff: axDiffText,
            secondaryWindows: secondaryWindowsText,
            screenshot: screenshotBase64,
            screenshotWidthPx: screenshotMetadata.map { Double($0.screenshotWidthPx) },
            screenshotHeightPx: screenshotMetadata.map { Double($0.screenshotHeightPx) },
            screenWidthPt: screenSizePt.map { Double($0.width) },
            screenHeightPt: screenSizePt.map { Double($0.height) },
            coordinateOrigin: screenSizePt != nil ? "top_left" : nil,
            captureDisplayId: screenshotMetadata.map { Double($0.captureDisplayId) },
            executionResult: executionResult,
            executionError: executionError,
            axTreeBlob: nil,
            screenshotBlob: nil,
            userGuidance: guidance
        )

        let screenshotRawBytes = screenshotData?.count ?? 0
        let screenshotBase64Bytes = screenshotBase64?.utf8.count ?? 0
        let axTreeBytes = axTreeText?.utf8.count ?? 0
        let axDiffBytes = axDiffText?.utf8.count ?? 0
        let secondaryWindowsBytes = secondaryWindowsText?.utf8.count ?? 0
        let payloadJSONBytes = screenshotBase64Bytes + axTreeBytes + axDiffBytes + secondaryWindowsBytes + 256
        let buildTimestampMs = Int(Date().timeIntervalSince1970 * 1_000)
        log.info(
            "[\(stepNumber)] cu_observation_build buildTsMs=\(buildTimestampMs) payloadJsonBytes=\(payloadJSONBytes) screenshotRawBytes=\(screenshotRawBytes) screenshotBase64Bytes=\(screenshotBase64Bytes) axTreeBytes=\(axTreeBytes) axDiffBytes=\(axDiffBytes) secondaryWindowsBytes=\(secondaryWindowsBytes)"
        )

        return observation
    }

    // MARK: - Tool Name Mapping

    private func mapToAgentAction(_ msg: CuActionMessage) -> AgentAction {
        let type: ActionType = switch msg.toolName {
        case "computer_use_click", "cu_click": .click
        case "computer_use_double_click", "cu_double_click": .doubleClick
        case "computer_use_right_click", "cu_right_click": .rightClick
        case "computer_use_type_text", "cu_type_text": .type
        case "computer_use_key", "cu_key": .key
        case "computer_use_scroll", "cu_scroll": .scroll
        case "computer_use_wait", "cu_wait": .wait
        case "computer_use_drag", "cu_drag": .drag
        case "computer_use_open_app", "cu_open_app": .openApp
        case "computer_use_run_applescript", "cu_run_applescript": .runAppleScript
        case "computer_use_done", "cu_done": .done
        case "computer_use_respond", "cu_respond": .respond
        default: .done
        }

        // Extract fields from input dict
        let x = extractCGFloat(from: msg.input, key: "x")
        let y = extractCGFloat(from: msg.input, key: "y")
        let toX = extractCGFloat(from: msg.input, key: "toX")
            ?? extractCGFloat(from: msg.input, key: "to_x")
        let toY = extractCGFloat(from: msg.input, key: "toY")
            ?? extractCGFloat(from: msg.input, key: "to_y")
        let text = msg.input["text"]?.value as? String
        let key = msg.input["key"]?.value as? String
        let scrollDirection = msg.input["direction"]?.value as? String
            ?? msg.input["scrollDirection"]?.value as? String
            ?? msg.input["scroll_direction"]?.value as? String
        let scrollAmount = extractInt(from: msg.input, key: "amount")
            ?? extractInt(from: msg.input, key: "scrollAmount")
            ?? extractInt(from: msg.input, key: "scroll_amount")
        let summary = msg.input["summary"]?.value as? String
        let waitDuration = extractInt(from: msg.input, key: "duration")
            ?? extractInt(from: msg.input, key: "waitDuration")
            ?? extractInt(from: msg.input, key: "wait_duration")
        let appName = msg.input["app_name"]?.value as? String
            ?? msg.input["appName"]?.value as? String
        let script = msg.input["script"]?.value as? String
        let elementId = extractInt(from: msg.input, key: "element_id")
            ?? extractInt(from: msg.input, key: "elementId")
        let toElementId = extractInt(from: msg.input, key: "to_element_id")
            ?? extractInt(from: msg.input, key: "toElementId")
        let elementDescription = msg.input["element_description"]?.value as? String
            ?? msg.input["elementDescription"]?.value as? String

        return AgentAction(
            type: type,
            reasoning: msg.reasoning ?? "",
            x: x,
            y: y,
            toX: toX,
            toY: toY,
            text: text,
            key: key,
            scrollDirection: scrollDirection,
            scrollAmount: scrollAmount,
            summary: summary,
            waitDuration: waitDuration,
            appName: appName,
            script: script,
            resolvedFromElementId: elementId,
            resolvedToElementId: toElementId,
            elementDescription: elementDescription
        )
    }

    private func resolveCoordinatesIfNeeded(for action: AgentAction, stepNumber: Int) async -> AgentAction? {
        var resolved = action

        switch resolved.type {
        case .click, .doubleClick, .rightClick:
            if resolved.x == nil || resolved.y == nil {
                guard let sourceId = resolved.resolvedFromElementId else {
                    await sendRecoverableExecutionError(
                        "Action requires either x/y coordinates or element_id.",
                        stepNumber: stepNumber
                    )
                    return nil
                }
                guard let center = elementCenter(for: sourceId) else {
                    await sendRecoverableExecutionError(
                        "Could not resolve element_id [\(sourceId)] in the focused window. Use an ID from CURRENT SCREEN STATE or provide x/y coordinates.",
                        stepNumber: stepNumber
                    )
                    return nil
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .scroll:
            if (resolved.x == nil || resolved.y == nil), let sourceId = resolved.resolvedFromElementId {
                guard let center = elementCenter(for: sourceId) else {
                    await sendRecoverableExecutionError(
                        "Could not resolve element_id [\(sourceId)] in the focused window. Use an ID from CURRENT SCREEN STATE or provide x/y coordinates.",
                        stepNumber: stepNumber
                    )
                    return nil
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .drag:
            if resolved.x == nil || resolved.y == nil {
                if let sourceId = resolved.resolvedFromElementId {
                    guard let center = elementCenter(for: sourceId) else {
                        await sendRecoverableExecutionError(
                            "Could not resolve source element_id [\(sourceId)] in the focused window. Use an ID from CURRENT SCREEN STATE or provide source x/y coordinates.",
                            stepNumber: stepNumber
                        )
                        return nil
                    }
                    resolved.x = center.x
                    resolved.y = center.y
                } else {
                    await sendRecoverableExecutionError(
                        "Drag action requires source coordinates (x/y) or element_id.",
                        stepNumber: stepNumber
                    )
                    return nil
                }
            }

            if resolved.toX == nil || resolved.toY == nil {
                if let destinationId = resolved.resolvedToElementId {
                    guard let center = elementCenter(for: destinationId) else {
                        await sendRecoverableExecutionError(
                            "Could not resolve destination to_element_id [\(destinationId)] in the focused window. Use an ID from CURRENT SCREEN STATE or provide to_x/to_y coordinates.",
                            stepNumber: stepNumber
                        )
                        return nil
                    }
                    resolved.toX = center.x
                    resolved.toY = center.y
                } else {
                    await sendRecoverableExecutionError(
                        "Drag action requires destination coordinates (to_x/to_y) or to_element_id.",
                        stepNumber: stepNumber
                    )
                    return nil
                }
            }

        default:
            break
        }

        return resolved
    }

    private func elementCenter(for elementId: Int) -> CGPoint? {
        guard let flatElements = previousFlatElements,
              let element = flatElements.first(where: { $0.id == elementId }),
              !element.frame.isEmpty else {
            return nil
        }
        return CGPoint(x: element.frame.midX, y: element.frame.midY)
    }

    private func sendRecoverableExecutionError(_ message: String, stepNumber: Int) async {
        log.warning("[\(stepNumber)] Coordinate resolution failed: \(message, privacy: .public)")
        // Resolution failures are non-blocked turns — reset the consecutive block streak
        // so they don't contribute to the "3 consecutive blocks" shutdown threshold.
        verifier.resetBlockCount()
        let obs = await buildObservation(executionResult: nil, executionError: message)
        if let obs {
            do {
                try daemonClient.send(obs)
            } catch {
                log.error("Failed to send recoverable execution error observation: \(error)")
            }
        }
        state = .thinking(step: stepNumber + 1, maxSteps: maxSteps)
    }

    private func extractCGFloat(from input: [String: AnyCodable], key: String) -> CGFloat? {
        guard let val = input[key]?.value else { return nil }
        if let intVal = val as? Int { return CGFloat(intVal) }
        if let doubleVal = val as? Double { return CGFloat(doubleVal) }
        return nil
    }

    private func extractInt(from input: [String: AnyCodable], key: String) -> Int? {
        guard let val = input[key]?.value else { return nil }
        if let intVal = val as? Int { return intVal }
        if let doubleVal = val as? Double { return Int(doubleVal) }
        return nil
    }

    // MARK: - Adaptive Delay

    /// Poll the AX tree until it changes or max polls are exhausted.
    private func waitForUISettle(previousTree: String?, previousHash: Int) async {
        // Always wait the minimum delay to let CGEvents propagate
        do {
            try await Task.sleep(nanoseconds: minDelayMs * 1_000_000)
        } catch {
            log.warning("UI settle minimum delay interrupted: \(error)")
            return
        }

        var elapsed = minDelayMs
        var pollCount = 0
        let maxPollCount = 5

        while elapsed < maxDelayMs && !isCancelled && pollCount < maxPollCount {
            if let result = enumerator.enumerateCurrentWindow() {
                let isFirstOrLastPoll = pollCount == 0 || pollCount == maxPollCount - 1

                if isFirstOrLastPoll {
                    let currentTree = AccessibilityTreeEnumerator.formatAXTree(
                        elements: result.elements,
                        windowTitle: result.windowTitle,
                        appName: result.appName
                    )
                    if currentTree != previousTree {
                        log.debug("UI settled after \(elapsed)ms (tree changed)")
                        return
                    }
                } else {
                    let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
                    let currentHash = Self.fastElementHash(flat)
                    if currentHash != previousHash {
                        log.debug("UI settled after \(elapsed)ms (element hash changed)")
                        return
                    }
                }
            }

            do {
                try await Task.sleep(nanoseconds: pollIntervalMs * 1_000_000)
            } catch {
                log.warning("UI settle poll sleep interrupted: \(error)")
                return
            }
            elapsed += pollIntervalMs
            pollCount += 1
        }

        log.debug("UI settle timeout after \(elapsed)ms (polls: \(pollCount))")
    }

    private static func fastElementHash(_ elements: [AXElement]) -> Int {
        var hasher = Hasher()
        hasher.combine(elements.count)
        for el in elements {
            hasher.combine(el.value)
            hasher.combine(el.title)
            hasher.combine(el.isFocused)
        }
        return hasher.finalize()
    }

    // MARK: - Conditional Secondary Windows

    private func shouldEnumerateSecondaryWindows(stepNumber: Int, lastAction: AgentAction?) -> Bool {
        if stepNumber == 1 { return true }
        if lastAction?.type == .openApp { return true }
        if taskMentionsMultipleApps() { return true }
        return false
    }

    private static let appKeywords: Set<String> = [
        "safari", "chrome", "firefox", "slack", "finder", "notes", "mail",
        "messages", "terminal", "vscode", "xcode", "spotify",
        "discord", "notion", "figma", "teams", "zoom", "preview",
        "textedit", "pages", "numbers", "keynote", "calendar"
    ]

    private static let crossAppPhrases = [
        "paste into", "drag from",
        "from safari", "from chrome", "from slack", "from finder",
        "from notes", "from mail", "from terminal", "from xcode",
        "to safari", "to chrome", "to slack", "to finder",
        "to notes", "to mail", "to terminal", "to xcode",
        "between apps", "between windows"
    ]

    private func taskMentionsMultipleApps() -> Bool {
        let lower = task.lowercased()
        for phrase in Self.crossAppPhrases {
            if lower.contains(phrase) { return true }
        }
        var appCount = 0
        for keyword in Self.appKeywords {
            if Self.matchesWholeWord(keyword, in: lower) {
                appCount += 1
                if appCount >= 2 { return true }
            }
        }
        return false
    }

    private static func matchesWholeWord(_ keyword: String, in text: String) -> Bool {
        let pattern = "\\b\(NSRegularExpression.escapedPattern(for: keyword))\\b"
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    // MARK: - Conditional Screenshot

    private func shouldCaptureScreenshot(stepNumber: Int, flatElements: [AXElement], lastAction: AgentAction?) -> Bool {
        if stepNumber == 1 { return true }
        if lastAction?.type == .openApp { return true }
        let interactiveCount = flatElements.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
        if interactiveCount < 3 { return true }
        if consecutiveUnchangedSteps >= 2 { return true }
        return false
    }

    // MARK: - Helper Methods

    /// Extracts all tool calls from the related ChatViewModel for notification purposes.
    private func extractToolCalls() -> [ToolCallData] {
        guard let viewModel = relatedViewModel else { return [] }

        // Collect tool calls from all assistant messages
        return viewModel.messages
            .filter { $0.role == .assistant }
            .flatMap { $0.toolCalls }
    }

    // MARK: - Control

    func pause() {
        isPaused = true
        let step = currentStepNumber
        state = .paused(step: step, maxSteps: maxSteps)
    }

    func resume() {
        isPaused = false
    }

    func cancel() {
        isCancelled = true
        messageLoopTask?.cancel()
        confirmationContinuation?.resume(returning: false)
        confirmationContinuation = nil
        // Tell the daemon to abort the server-side CU session so it stops burning tokens
        do {
            try daemonClient.send(CuSessionAbortMessage(sessionId: id))
        } catch {
            log.error("Failed to send session abort on cancel: \(error)")
        }
    }

    func approveConfirmation() {
        confirmationContinuation?.resume(returning: true)
    }

    func rejectConfirmation() {
        confirmationContinuation?.resume(returning: false)
    }

    func undo() {
        let undoAction = AgentAction(type: .key, reasoning: "User-initiated undo", key: "cmd+z")
        Task { @MainActor in
            do {
                _ = try await executor.execute(undoAction)
                undoCount += 1
                log.info("Undo #\(self.undoCount) sent")
            } catch {
                log.error("Undo failed: \(error.localizedDescription)")
            }
        }
    }
}
