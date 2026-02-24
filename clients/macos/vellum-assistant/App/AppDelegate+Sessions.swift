import AppKit
import UserNotifications
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+Sessions")

extension AppDelegate {

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
                notificationService: self.services.activityNotificationService
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

            // Hide main window so the target app becomes frontmost for CU
            let mainWindowWasVisible = self.mainWindow?.isVisible ?? false
            if mainWindowWasVisible {
                self.mainWindow?.hide()
            }

            await session.run()
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            overlay.close()
            self.overlayWindow = nil
            self.currentSession = nil
            self.currentTextSession = nil
            self.ambientAgent.resume()
            if mainWindowWasVisible {
                self.mainWindow?.show()
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
            do {
                try self.daemonClient.send(TaskSubmitMessage(
                    task: effectiveTask,
                    screenWidth: Int(screenBounds.width),
                    screenHeight: Int(screenBounds.height),
                    attachments: ipcAttachments,
                    source: submission.source
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
                    log.error("Task routing failed: \(err.message, privacy: .private)")
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
                    notificationService: self.services.activityNotificationService
                )
                // Don't bind relatedViewModel — sessions started via startSession() don't
                // originate from a chat thread, so there's no ChatViewModel to extract
                // tool calls from. Tool calls are tracked by the daemon session itself.
                self.currentSession = session
                let overlay = SessionOverlayWindow(session: session)
                overlay.show()
                self.overlayWindow = overlay
                self.ambientAgent.pause()
                await session.run()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                overlay.close()
                self.overlayWindow = nil
                self.currentSession = nil
                self.ambientAgent.resume()

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

    // MARK: - Background Session (Quick Chat)

    /// Starts a background session that sends a message to the daemon without
    /// showing any UI. When the assistant responds, a macOS notification is
    /// delivered. Multiple background sessions can run concurrently.
    func startBackgroundSession(task: String, source: String) {
        let sessionTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sessionTask.isEmpty else { return }

        Task { @MainActor in
            // Ensure daemon connection
            if !daemonClient.isConnected {
                log.info("Daemon not connected, attempting to connect before background session")
                do {
                    try await daemonClient.connect()
                    self.setupAmbientAgent()
                } catch {
                    log.error("Failed to connect to daemon for background session: \(error.localizedDescription)")
                    self.deliverQuickChatErrorNotification(task: sessionTask)
                    return
                }
            }

            // Subscribe to daemon stream before sending task_submit
            let messageStream = self.daemonClient.subscribe()

            // Send task_submit
            let screenBounds = CGDisplayBounds(CGMainDisplayID())
            do {
                try self.daemonClient.send(TaskSubmitMessage(
                    task: sessionTask,
                    screenWidth: Int(screenBounds.width),
                    screenHeight: Int(screenBounds.height),
                    attachments: nil,
                    source: source
                ))
            } catch {
                log.error("Failed to send background task submit: \(error)")
                return
            }

            // Wait for task_routed, then listen for the response
            var routedMessage: TaskRoutedMessage?
            for await message in messageStream {
                if case .taskRouted(let routed) = message {
                    routedMessage = routed
                    break
                }
                if case .error(let err) = message {
                    log.error("Background task routing failed: \(err.message, privacy: .private)")
                    break
                }
            }

            guard let routed = routedMessage else {
                log.error("Background session: no routed message received")
                return
            }

            let sessionId = routed.sessionId

            // Create a thread in ThreadManager so the user can find it later
            if let threadManager = self.mainWindow?.threadManager {
                threadManager.createTaskRunThread(
                    conversationId: sessionId,
                    workItemId: "",
                    title: String(sessionTask.prefix(50))
                )
            }

            // Listen for the assistant response in the background
            var accumulatedText = ""
            for await message in messageStream {
                switch message {
                case .assistantTextDelta(let delta):
                    accumulatedText += delta.text

                case .messageComplete(let complete) where complete.sessionId == sessionId:
                    let responseText = accumulatedText.isEmpty ? "(No response)" : accumulatedText
                    self.deliverQuickChatNotification(
                        responseText: responseText,
                        conversationId: sessionId
                    )
                    return

                case .generationHandoff(let handoff) where handoff.sessionId == sessionId:
                    let responseText = accumulatedText.isEmpty ? "(No response)" : accumulatedText
                    self.deliverQuickChatNotification(
                        responseText: responseText,
                        conversationId: sessionId
                    )
                    return

                case .cuError(let error) where error.sessionId == sessionId:
                    self.deliverQuickChatNotification(
                        responseText: "Error: \(error.message)",
                        conversationId: sessionId
                    )
                    return

                case .sessionError(let error) where error.sessionId == sessionId:
                    self.deliverQuickChatNotification(
                        responseText: "Error: \(error.userMessage)",
                        conversationId: sessionId
                    )
                    return

                default:
                    break
                }
            }
        }
    }

    private func deliverQuickChatNotification(responseText: String, conversationId: String) {
        let content = UNMutableNotificationContent()
        content.title = "Quick Chat"
        // Truncate long responses for the notification body
        if responseText.count > 200 {
            content.body = String(responseText.prefix(200)) + "..."
        } else {
            content.body = responseText
        }
        content.sound = .default
        content.categoryIdentifier = "QUICK_CHAT_RESPONSE"
        content.userInfo = ["conversationId": conversationId]

        let request = UNNotificationRequest(
            identifier: "quick-chat-\(conversationId)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                log.error("Failed to post quick chat notification: \(error.localizedDescription)")
            }
        }
    }

    private func deliverQuickChatErrorNotification(task: String) {
        let content = UNMutableNotificationContent()
        content.title = "Quick Chat"
        content.body = "Could not connect to the assistant. Please try again."
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "quick-chat-error-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                log.error("Failed to post quick chat error notification: \(error.localizedDescription)")
            }
        }
    }

    /// Opens the main window and navigates to the thread for the given conversation ID.
    /// Retries if the thread isn't populated yet (e.g., ThreadManager hasn't loaded it).
    func openQuickChatThread(conversationId: String?) {
        showMainWindow()
        guard let conversationId else { return }

        func trySelect() -> Bool {
            guard let threadManager = mainWindow?.threadManager,
                  let thread = threadManager.threads.first(where: { $0.sessionId == conversationId }) else {
                return false
            }
            threadManager.activeThreadId = thread.id
            return true
        }

        if trySelect() { return }

        // Thread may not be loaded yet — retry up to 5 times with 500ms delay
        Task { @MainActor in
            for _ in 0..<5 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if trySelect() { return }
            }
            log.warning("Could not find thread for conversation \(conversationId) after retries")
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
