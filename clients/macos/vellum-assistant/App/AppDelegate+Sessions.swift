import AppKit
import Combine
import UserNotifications
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+Sessions")

extension AppDelegate {

    // MARK: - Session

    func startSession(task: String, source: String? = nil) {
        startSession(submission: TaskSubmission(task: task, attachments: [], source: source))
    }

    /// Sends the user's task as a regular message via POST /v1/messages.
    /// The model decides whether to use computer-use tools; CU execution
    /// flows through the host_cu_request / host_cu_result pattern handled
    /// by HostCuExecutor.
    func startSession(submission: TaskSubmission) {
        guard currentSession == nil && currentTextSession == nil && !isStartingSession else { return }
        isStartingSession = true

        let sessionTask = submission.task.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveTask = !sessionTask.isEmpty ? sessionTask : "Use the attached files as context."

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

            // Route the task as a regular message through the main chat flow.
            // The daemon will classify it and invoke CU tools via host_cu_request
            // if computer use is needed.
            self.ensureMainWindowExists()
            if let viewModel = self.mainWindow?.threadManager.activeViewModel {
                _ = viewModel.sendSilently(effectiveTask)
            } else {
                log.warning("No active chat view model — cannot send message")
            }

            self.showMainWindow()
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
        let proxy = HostCuSessionProxy(task: "", sessionId: UUID().uuidString)
        proxy.state = .failed(reason: "Failed to connect to the assistant.")
        currentSession = proxy
        let overlay = SessionOverlayWindow(session: proxy)
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
