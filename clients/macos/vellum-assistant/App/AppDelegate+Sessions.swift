import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+Sessions")

extension AppDelegate {

    // MARK: - Computer Use Post-Run UX

    /// Return a user-facing explanation when CU ended without a successful completion/response.
    /// This avoids the "silent disappear" feeling when the overlay auto-closes.
    private func computerUseEndMessage(for session: ComputerUseSession) -> String? {
        let state = session.state

        func completionLooksUnsuccessful(_ text: String) -> Bool {
            let lower = text.lowercased()
            let signals = [
                "wasn't able",
                "couldn't",
                "could not",
                "unable",
                "permission denied",
                "denied",
                "not able",
                "failed",
            ]
            return signals.contains { lower.contains($0) }
        }

        let baseMessage: String? = switch state {
        case .completed(let summary, _):
            if completionLooksUnsuccessful(summary) {
                "Computer control finished with warnings: \(summary.replacingOccurrences(of: "\n", with: " "))"
            } else {
                nil
            }
        case .responded(let answer, _):
            if completionLooksUnsuccessful(answer) {
                "Computer control finished with warnings: \(answer.replacingOccurrences(of: "\n", with: " "))"
            } else {
                nil
            }
        case .failed(let reason):
            "Computer control stopped: \(reason)"
        case .cancelled:
            "Computer control was cancelled."
        case .awaitingConfirmation(let reason):
            "Computer control stopped while waiting for confirmation: \(reason)"
        case .running, .thinking, .paused, .idle:
            "Computer control ended unexpectedly before finishing the task."
        }

        if let recordingWarning = session.qaRecordingWarningMessage {
            if let baseMessage {
                return "\(baseMessage) Recording warning: \(recordingWarning)"
            }
            return "Computer control finished with warnings: \(recordingWarning)"
        }

        return baseMessage
    }

    // MARK: - External App Target Detection

    /// Returns `true` when the CU session targets an external app (not Vellum
    /// itself). When `bundleId` is nil the session has no target constraint and
    /// is treated as "self" (backward compatibility).
    private func isExternalAppTarget(bundleId: String?) -> Bool {
        guard let bundleId, !bundleId.isEmpty else { return false }
        let selfBundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"
        return bundleId != selfBundleId
    }

    // MARK: - Accessibility Permission

    /// Poll for accessibility permission after prompting, giving the user time to grant it in System Settings.
    /// `AXIsProcessTrustedWithOptions` returns immediately even with `prompt: true`, so we need to poll.
    private func waitForAccessibilityPermission() async -> Bool {
        // Already granted — no need to prompt or poll
        if ActionExecutor.checkAccessibilityPermission(prompt: false) { return true }

        // Show the OS prompt
        _ = ActionExecutor.checkAccessibilityPermission(prompt: true)

        // Poll every 500ms for up to 30 seconds
        for _ in 0..<60 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if Task.isCancelled { return false }
            if ActionExecutor.checkAccessibilityPermission(prompt: false) { return true }
        }
        return false
    }

    // MARK: - Escalation

    /// Handle escalation from an active text_qa session to foreground computer use.
    func handleEscalationToComputerUse(routed: TaskRoutedMessage) {
        Task { @MainActor in
            guard await waitForAccessibilityPermission() else {
                log.error("Accessibility permission denied — cannot start computer use session \(routed.sessionId)")
                do {
                    try daemonClient.send(CuSessionAbortMessage(sessionId: routed.sessionId))
                } catch {
                    log.error("Failed to send CU session abort for escalation \(routed.sessionId): \(error)")
                }
                self.mainWindow?.windowState.showToast(
                    message: "Computer control requires Accessibility permission. Grant it in System Settings → Privacy & Security → Accessibility.",
                    style: .error
                )
                return
            }

            let storedMaxSteps = UserDefaults.standard.integer(forKey: "maxStepsPerSession")
            let maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 50
            let session = ComputerUseSession(
                task: routed.task ?? "Escalated task",
                daemonClient: self.daemonClient,
                maxSteps: maxSteps,
                sessionId: routed.sessionId,
                skipSessionCreate: true,
                notificationService: self.services.activityNotificationService,
                screenRecorder: (routed.qaMode == true) ? ScreenRecorder() : nil,
                reportToSessionId: routed.reportToSessionId,
                qaMode: routed.qaMode ?? false,
                retentionDays: routed.retentionDays.flatMap { Int($0) } ?? 7,
                captureScope: routed.captureScope ?? "display",
                includeAudio: routed.includeAudio ?? false,
                requiresRecording: routed.requiresRecording ?? false,
                targetAppName: routed.targetAppName,
                targetAppBundleId: routed.targetAppBundleId
            )
            // Don't bind relatedViewModel for escalated sessions — the active view model
            // may be unrelated if the user switched threads. Tool calls for escalated
            // sessions are tracked by the daemon session, not by ChatViewModel.
            self.currentSession = session

            let overlay = SessionOverlayWindow(session: session)
            overlay.show()
            self.overlayWindow = overlay
            self.ambientAgent.pause()

            // Close the text response window but keep the text session reference
            // (no de-escalation for MVP — text session is effectively done)
            self.textResponseWindow?.close()
            self.textResponseWindow = nil

            // Keep the main app visible during escalated CU so permission prompts
            // and status are always visible to the user — but only when the
            // target app IS Vellum itself (or unspecified). For external-app QA
            // sessions (e.g., targeting Slack, Chrome), activating Vellum's main
            // window would steal focus from the app under test.
            if !self.isExternalAppTarget(bundleId: routed.targetAppBundleId) {
                self.showMainWindow()
            }

            await session.run()
            let endMessage = self.computerUseEndMessage(for: session)
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            overlay.close()
            self.overlayWindow = nil
            self.currentSession = nil
            self.currentTextSession = nil
            self.ambientAgent.resume()
            if let endMessage {
                self.mainWindow?.windowState.showToast(message: endMessage, style: .error)
            }
        }
    }

    // MARK: - Session

    func startSession(task: String, source: String? = nil) {
        startSession(submission: TaskSubmission(task: task, attachments: [], source: source))
    }

    func startSession(submission: TaskSubmission) {
        guard currentSession == nil && currentTextSession == nil && !isStartingSession else { return }
        isStartingSession = true

        let sessionTask = submission.task.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveTask = !sessionTask.isEmpty ? sessionTask : "Use the attached files as context."

        // Ensure daemon connection before starting any session
        startSessionTask = Task { @MainActor in
            defer { self.isStartingSession = false; self.startSessionTask = nil }

            if !daemonClient.isConnected {
                log.info("Daemon not connected, attempting to connect before session start")
                do {
                    try await daemonClient.connect()
                    self.setupAmbientAgent()
                } catch {
                    log.error("Failed to connect to daemon: \(error.localizedDescription)")
                    self.showDaemonConnectionError()
                    return
                }
            }

            // Show thinking indicator IMMEDIATELY
            let thinking = ThinkingIndicatorWindow()
            thinking.show()
            self.thinkingWindow = thinking

            // 1. Subscribe to daemon stream before sending task_submit
            let messageStream = self.daemonClient.subscribe()

            // 2. Send task_submit — daemon classifies and creates the session
            let screenBounds = CGDisplayBounds(CGMainDisplayID())
            let ipcAttachments: [IPCAttachment]? = submission.attachments.isEmpty ? nil : submission.attachments.map {
                IPCAttachment(
                    filename: $0.fileName,
                    mimeType: $0.mimeType,
                    data: $0.data.base64EncodedString(),
                    extractedText: $0.extractedText
                )
            }
            // Pass the active thread's conversation ID so the daemon can set reportToSessionId for QA sessions
            let activeConversationId = self.mainWindow?.threadManager.activeViewModel?.sessionId

            do {
                try self.daemonClient.send(TaskSubmitMessage(
                    task: effectiveTask,
                    screenWidth: Int(screenBounds.width),
                    screenHeight: Int(screenBounds.height),
                    attachments: ipcAttachments,
                    source: submission.source,
                    conversationId: activeConversationId
                ))
            } catch {
                log.error("Failed to send task submit message: \(error)")
            }

            // 3. Wait for task_routed response (or error)
            var routedMessage: TaskRoutedMessage?
            for await message in messageStream {
                guard !Task.isCancelled else { break }
                if case .taskRouted(let routed) = message {
                    routedMessage = routed
                    break
                }
                if case .error(let err) = message {
                    log.error("Task routing failed: \(err.message)")
                    break
                }
            }

            // Check if cancelled or failed during classification
            guard !Task.isCancelled, let routed = routedMessage else {
                thinking.close()
                self.thinkingWindow = nil
                return
            }

            // Dismiss thinking indicator
            thinking.close()
            self.thinkingWindow = nil

            switch routed.interactionType {
            case "computer_use":
                guard await self.waitForAccessibilityPermission() else {
                    log.error("Accessibility permission denied — cannot start computer use session \(routed.sessionId)")
                    do {
                        try self.daemonClient.send(CuSessionAbortMessage(sessionId: routed.sessionId))
                    } catch {
                        log.error("Failed to send CU session abort for \(routed.sessionId): \(error)")
                    }
                    return
                }
                let storedMaxSteps = UserDefaults.standard.integer(forKey: "maxStepsPerSession")
                let maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 50
                let session = ComputerUseSession(
                    task: effectiveTask,
                    daemonClient: self.daemonClient,
                    maxSteps: maxSteps,
                    attachments: submission.attachments,
                    sessionId: routed.sessionId,
                    skipSessionCreate: true,
                    notificationService: self.services.activityNotificationService,
                    screenRecorder: (routed.qaMode == true) ? ScreenRecorder() : nil,
                    reportToSessionId: routed.reportToSessionId,
                    qaMode: routed.qaMode ?? false,
                    retentionDays: routed.retentionDays.flatMap { Int($0) } ?? 7,
                    captureScope: routed.captureScope ?? "display",
                    includeAudio: routed.includeAudio ?? false,
                    requiresRecording: routed.requiresRecording ?? false,
                    targetAppName: routed.targetAppName,
                    targetAppBundleId: routed.targetAppBundleId
                )
                // Don't bind relatedViewModel — sessions started via startSession() don't
                // originate from a chat thread, so there's no ChatViewModel to extract
                // tool calls from. Tool calls are tracked by the daemon session itself.
                self.currentSession = session
                let overlay = SessionOverlayWindow(session: session)
                overlay.show()
                self.overlayWindow = overlay
                self.ambientAgent.pause()
                let looksLikeQaTask = effectiveTask.localizedCaseInsensitiveContains("qa")
                    || effectiveTask.localizedCaseInsensitiveContains("test")
                    || effectiveTask.localizedCaseInsensitiveContains("verify")
                if routed.qaMode == true || looksLikeQaTask {
                    // QA/test CU sessions should keep the main app open —
                    // but only when the target app is Vellum itself (or
                    // unspecified). For external-app QA sessions, activating
                    // Vellum would steal focus from the app under test.
                    if !self.isExternalAppTarget(bundleId: routed.targetAppBundleId) {
                        self.showMainWindow()
                    }
                }
                await session.run()
                let endMessage = self.computerUseEndMessage(for: session)
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                overlay.close()
                self.overlayWindow = nil
                self.currentSession = nil
                self.ambientAgent.resume()
                if let endMessage {
                    self.mainWindow?.windowState.showToast(message: endMessage, style: .error)
                }

            default: // text_qa
                let session = TextSession(
                    task: effectiveTask,
                    daemonClient: self.daemonClient,
                    attachments: submission.attachments,
                    sessionId: routed.sessionId,
                    skipSessionCreate: true,
                    existingStream: messageStream
                )
                self.currentTextSession = session
                let inputState = ConversationInputState()
                let window = TextResponseWindow(session: session, inputState: inputState)
                window.show()
                self.textResponseWindow = window
                self.ambientAgent.pause()

                // Clean up when the user closes the panel
                window.onClose = { [weak self] in
                    self?.currentTextSession?.cancel()
                    self?.textResponseWindow = nil
                    self?.currentTextSession = nil
                    self?.ambientAgent.resume()
                }

                await session.run()
            }
        }
    }

    func showDaemonConnectionError() {
        // Create a temporary session in failed state to show the error in the overlay
        let session = ComputerUseSession(
            task: "",
            daemonClient: daemonClient,
            maxSteps: 1
        )
        session.state = .failed(reason: "Failed to connect to the assistant.")
        currentSession = session
        let overlay = SessionOverlayWindow(session: session)
        overlay.show()
        overlayWindow = overlay
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000) // Show error for 5 seconds
            overlay.close()
            self.overlayWindow = nil
            self.currentSession = nil
        }
    }
}
