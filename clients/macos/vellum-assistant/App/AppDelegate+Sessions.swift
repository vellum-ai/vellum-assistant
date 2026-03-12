import AppKit
import Combine
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
            // Dismiss any active host CU overlay to avoid conflicts
            self.dismissHostCuOverlay()

            let shouldAutoApproveTools = routed.escalatedFrom
                .map { self.autoApproveEscalationSessionIds.contains($0) } ?? false

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
            session.autoApproveTools = shouldAutoApproveTools
            if let sourceSessionId = routed.escalatedFrom {
                self.autoApproveEscalationSessionIds.remove(sourceSessionId)
            }
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

            // Announce CU escalation via voice if voice mode is active
            let voiceManager = self.mainWindow?.voiceModeManager
            let voiceModeWasActive = voiceManager?.state != .off && voiceManager?.state != nil
            if voiceModeWasActive {
                voiceManager?.speakTransient("Let me take over the screen for a moment.")
                voiceManager?.pauseConversationTimeout()
            }

            await session.run()

            // Announce CU completion via voice if voice mode is still active
            if voiceModeWasActive, let voiceManager, voiceManager.state != .off {
                let summary: String
                switch session.state {
                case .completed(let s, _), .responded(let s, _):
                    summary = s
                case .failed:
                    summary = "Something went wrong while controlling the screen."
                case .cancelled:
                    summary = "Screen control was cancelled."
                default:
                    summary = "All done with the screen."
                }
                voiceManager.speakTransient(summary)
                voiceManager.resumeConversationTimeout()
            }

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
            let messageAttachments: [UserMessageAttachment]? = submission.attachments.isEmpty ? nil : submission.attachments.map {
                UserMessageAttachment(
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
                    attachments: messageAttachments,
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

            let shouldAutoApproveTools = submission.isVoiceAction
            switch routed.interactionType {
            case "computer_use":
                // Dismiss any active host CU overlay to avoid conflicts
                self.dismissHostCuOverlay()
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
                session.autoApproveTools = shouldAutoApproveTools
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
                if shouldAutoApproveTools {
                    self.autoApproveEscalationSessionIds.insert(routed.sessionId)
                }
                let routedSessionId = routed.sessionId
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
                    self?.autoApproveEscalationSessionIds.remove(routedSessionId)
                    self?.currentTextSession?.cancel()
                    self?.textResponseWindow = nil
                    self?.currentTextSession = nil
                    self?.ambientAgent.resume()
                }

                await session.run()
                self.autoApproveEscalationSessionIds.remove(routedSessionId)
            }
        }
    }

    /// Creates the thread in the sidebar and applies urgency surfacing policy.
    /// Guardian questions are time-sensitive, so they are foregrounded when the
    /// app is active. All notification types get a fallback native alert when
    /// backgrounded to guarantee delivery if the notification_intent event is late.
    func handleNotificationThreadCreated(_ msg: NotificationThreadCreated) {
        // Guardian scoping: skip thread creation for notifications targeted at
        // a different guardian identity. When the local principal is nil (not yet
        // bootstrapped), pass through all notifications so urgent prompts aren't
        // silently missed during startup.
        if let target = msg.targetGuardianPrincipalId {
            let localId = ActorTokenManager.getGuardianPrincipalId()
            if let localId, localId != target {
                log.info("Skipping notification_thread_created for guardian \(target) — local guardian is \(localId)")
                return
            }
        }

        ensureMainWindowExists()
        mainWindow?.threadManager.createNotificationThread(
            conversationId: msg.conversationId,
            title: msg.title,
            sourceEventName: msg.sourceEventName
        )

        if NSApp.isActive {
            maybePromptNotificationAuthorizationForThreadCreated()
        }

        // Guardian questions get foregrounded immediately when the app is active.
        if msg.sourceEventName == "guardian.question" && NSApp.isActive {
            openConversationThread(conversationId: msg.conversationId)
            return
        }

        // When the app is in the background, schedule a fallback notification.
        // notification_intent is normally emitted moments later by the vellum
        // adapter; if it arrives in time the fallback is cancelled to prevent
        // duplicates. When active, the thread is already visible in the sidebar
        // so no fallback is needed.
        guard !NSApp.isActive else { return }

        scheduleNotificationFallback(
            conversationId: msg.conversationId,
            title: msg.title,
            sourceEventName: msg.sourceEventName
        )
    }

    /// Opens the main window and navigates to the thread for the given conversation ID.
    /// Retries if the thread isn't populated yet (e.g., ThreadManager hasn't loaded it).
    /// Used by Quick Chat and notification deep links.
    /// - Parameters:
    ///   - conversationId: The conversation to navigate to.
    ///   - anchorMessageId: Optional message ID to scroll to after the thread is selected.
    func openConversationThread(conversationId: String?, anchorMessageId: String? = nil) {
        showMainWindow()
        guard let conversationId else { return }

        func trySelect() -> Bool {
            guard let threadManager = mainWindow?.threadManager,
                  let thread = threadManager.threads.first(where: { $0.sessionId == conversationId }) else {
                return false
            }
            threadManager.activeThreadId = thread.id
            // Switch the main content area to the chat thread so the user sees it
            // even if they were last viewing a panel, app, or other non-chat view.
            mainWindow?.windowState.selection = nil
            // Clear unseen state and notify the daemon when deep-linking into a
            // conversation. selectThread's unseen-clear is guarded by
            // id != previousActiveId, which is false when activeThreadId was
            // already set above, so we call markConversationSeen explicitly to
            // keep both the local flag and the daemon's server-side state in sync.
            threadManager.markConversationSeen(threadId: thread.id)
            // Set pending anchor message so the message list scrolls to the
            // relevant notification message when the view appears.
            if let anchorMessageId, let anchorUUID = UUID(uuidString: anchorMessageId) {
                threadManager.setPendingAnchorMessage(threadId: thread.id, messageId: anchorUUID)
            }
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

    // MARK: - Host CU Overlay (Proxy-Based Computer Use)

    /// Returns the existing or newly created `HostCuSessionProxy` for the given
    /// session. On first call for a session, creates the overlay window and pauses
    /// ambient monitoring — matching the UX of foreground CU sessions.
    func getOrCreateHostCuOverlay(sessionId: String, request: HostCuRequest) -> HostCuSessionProxy? {
        // If there's already a foreground CU session, skip the overlay to avoid conflicts
        guard currentSession == nil else {
            log.debug("Skipping host CU overlay — foreground CU session is active")
            return nil
        }

        // Return existing proxy if this session already has one
        if activeOverlayConversationId == sessionId, let proxy = activeHostCuProxy {
            return proxy
        }

        // Dismiss any stale overlay from a previous session
        dismissHostCuOverlay()

        let taskDescription = request.reasoning ?? "Computer use"
        let proxy = HostCuSessionProxy(task: taskDescription, sessionId: sessionId)
        proxy.state = .thinking(step: request.stepNumber, maxSteps: 50)

        // Wire cancel to abort the main conversation session on the daemon
        proxy.onCancel = { [weak self] in
            guard let self else { return }
            do {
                try self.daemonClient.send(CancelMessage(sessionId: sessionId))
            } catch {
                log.error("Failed to send cancel for host CU session \(sessionId): \(error)")
            }
            self.dismissHostCuOverlay()
        }

        self.activeHostCuProxy = proxy
        self.activeOverlayConversationId = sessionId

        let overlay = SessionOverlayWindow(session: proxy)
        overlay.show()
        self.overlayWindow = overlay
        self.ambientAgent.pause()

        // Hide main window so the target app becomes frontmost for CU
        if mainWindow?.isVisible == true {
            mainWindow?.hide()
        }

        // Watch for terminal states and auto-dismiss after a delay.
        // Use Combine sink instead of async publisher to avoid holding
        // a long-lived task that blocks forever if terminal state is never reached.
        hostCuOverlayCleanupTask?.cancel()
        hostCuOverlayCleanupTask = nil
        proxy.statePublisher
            .sink { [weak self] state in
                guard let self else { return }
                switch state {
                case .completed, .responded, .failed, .cancelled:
                    // Terminal state — schedule delayed cleanup
                    self.hostCuOverlayCleanupTask?.cancel()
                    self.hostCuOverlayCleanupTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 10_000_000_000) // 10s
                        guard !Task.isCancelled else { return }
                        self?.dismissHostCuOverlay()
                    }
                default:
                    break
                }
            }
            .store(in: &hostCuOverlayCancellables)

        log.info("Created host CU overlay for session \(sessionId)")
        return proxy
    }

    /// Dismiss the host CU overlay and clean up all associated state.
    func dismissHostCuOverlay() {
        hostCuOverlayCleanupTask?.cancel()
        hostCuOverlayCleanupTask = nil
        hostCuOverlayCancellables.removeAll()

        overlayWindow?.close()
        overlayWindow = nil
        activeHostCuProxy = nil
        activeOverlayConversationId = nil
        ambientAgent.resume()

        // Restore main window if it was hidden
        if mainWindow?.isVisible == false {
            mainWindow?.show()
        }
    }
}
