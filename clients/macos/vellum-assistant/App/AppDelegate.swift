import AppKit
import CoreText
import SwiftUI
import HotKey
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

enum InteractionType {
    case computerUse
    case textQA
}

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var hotKey: HotKey?
    private var escapeMonitor: Any?
    private var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    var currentTextSession: TextSession?
    private var isStartingSession = false
    private var startSessionTask: Task<Void, Never>?
    private var textResponseWindow: TextResponseWindow?
    private var voiceInput: VoiceInputManager?
    private var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    private var thinkingWindow: ThinkingIndicatorWindow?
    public let ambientAgent = AmbientAgent()
    let daemonClient = DaemonClient()
    let surfaceManager = SurfaceManager()
    let toolConfirmationManager = ToolConfirmationManager()
    private let daemonLauncher = DaemonLauncher()
    private let updateManager = UpdateManager()

    private var onboardingWindow: OnboardingWindow?
    private var mainWindow: MainWindow?
    private var settingsWindow: NSWindow?
    #if DEBUG
    private var galleryWindow: ComponentGalleryWindow?
    #endif
    private var windowObserver: Any?
    private var settingsWindowObserver: Any?
    private weak var recordingViewModel: ChatViewModel?

    public func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        registerBundledFonts()

        #if DEBUG
        let skipOnboarding = CommandLine.arguments.contains("--skip-onboarding")
        #else
        let skipOnboarding = false
        #endif

        if !skipOnboarding && !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") {
            showOnboarding()
            return
        }

        setupDaemonClient()
        setupMenuBar()
        setupHotKey()
        setupEscapeMonitor()
        setupVoiceInput()
        setupAmbientAgent()
        setupSurfaceManager()
        setupToolConfirmationManager()
        setupWindowObserver()
        setupNotifications()
        setupAutoUpdate()
        showMainWindow()
    }

    private func setupDaemonClient() {
        // Show macOS notification when a pomodoro timer completes
        daemonClient.onTimerCompleted = { msg in
            let content = UNMutableNotificationContent()
            content.title = "Timer Complete"
            content.body = "\"\(msg.label)\" (\(Int(msg.durationMinutes)) min) is done!"
            content.sound = .default

            let request = UNNotificationRequest(
                identifier: "timer-\(msg.timerId)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { error in
                if let error {
                    log.error("Failed to post timer notification: \(error.localizedDescription)")
                }
            }
        }

        // Handle escalation: text_qa -> computer_use via request_computer_control
        daemonClient.onTaskRouted = { [weak self] routed in
            guard let self else { return }
            // Only handle escalation messages (those with escalatedFrom set)
            guard routed.escalatedFrom != nil,
                  routed.interactionType == "computer_use" else { return }
            self.handleEscalationToComputerUse(routed: routed)
        }

        Task {
            // Launch the bundled daemon if present (release builds)
            try? await daemonLauncher.launchIfNeeded()
            try? await daemonClient.connect()
            // Once connected, start ambient agent if it was waiting for daemon
            if daemonClient.isConnected {
                setupAmbientAgent()
            }
        }
    }

    /// Handle escalation from an active text_qa session to foreground computer use.
    private func handleEscalationToComputerUse(routed: TaskRoutedMessage) {
        guard ActionExecutor.checkAccessibilityPermission(prompt: true) else { return }

        let storedMaxSteps = UserDefaults.standard.integer(forKey: "maxStepsPerSession")
        let maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 50
        let session = ComputerUseSession(
            task: routed.task ?? "Escalated task",
            daemonClient: self.daemonClient,
            maxSteps: maxSteps,
            sessionId: routed.sessionId,
            skipSessionCreate: true
        )
        self.currentSession = session

        let overlay = SessionOverlayWindow(session: session)
        overlay.show()
        self.overlayWindow = overlay
        self.ambientAgent.pause()

        // Close the text response window but keep the text session reference
        // (no de-escalation for MVP — text session is effectively done)
        self.textResponseWindow?.close()
        self.textResponseWindow = nil

        Task { @MainActor in
            await session.run()
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            overlay.close()
            self.overlayWindow = nil
            self.currentSession = nil
            self.currentTextSession = nil
            self.ambientAgent.resume()
        }
    }

    private func setupAutoUpdate() {
        updateManager.onWillInstallUpdate = { [weak self] in
            self?.daemonLauncher.stop()
        }
        updateManager.startAutomaticChecks()
    }

    private func setupSurfaceManager() {
        // Wire daemon surface messages to SurfaceManager
        daemonClient.onSurfaceShow = { [weak self] msg in
            self?.surfaceManager.showSurface(msg)
        }
        daemonClient.onSurfaceUpdate = { [weak self] msg in
            self?.surfaceManager.updateSurface(msg)
        }
        daemonClient.onSurfaceDismiss = { [weak self] msg in
            self?.surfaceManager.dismissSurface(msg)
        }

        // Wire SurfaceManager action callback to DaemonClient
        surfaceManager.onAction = { [weak self] sessionId, surfaceId, actionId, data in
            guard let self else { return }
            let codableData: [String: AnyCodable]? = data?.mapValues { AnyCodable($0) }
            try? self.daemonClient.sendSurfaceAction(
                sessionId: sessionId,
                surfaceId: surfaceId,
                actionId: actionId,
                data: codableData
            )
        }

        // Data request: JS -> Swift -> daemon
        surfaceManager.onDataRequest = { [weak self] surfaceId, callId, method, appId, recordId, data in
            let codableData = data?.mapValues { AnyCodable($0) }
            try? self?.daemonClient.send(AppDataRequestMessage(
                surfaceId: surfaceId,
                callId: callId,
                method: method,
                appId: appId,
                recordId: recordId,
                data: codableData
            ))
        }

        // Data response: daemon -> Swift -> JS
        daemonClient.onAppDataResponse = { [weak self] msg in
            self?.surfaceManager.resolveDataResponse(surfaceId: msg.surfaceId, response: msg)
        }
    }

    private func setupToolConfirmationManager() {
        daemonClient.onConfirmationRequest = { [weak self] msg in
            // Only suppress the floating panel when the main chat window is visible
            // AND the app is active (frontmost). NSWindow.isVisible returns true even
            // when the window is behind other apps, so we must also check NSApp.isActive
            // to avoid silently dropping confirmations when the user can't see the inline UI.
            guard self?.mainWindow?.isVisible != true || !NSApp.isActive else { return }
            self?.toolConfirmationManager.showConfirmation(msg)
        }
        toolConfirmationManager.onResponse = { [weak self] requestId, decision in
            guard let self else { return false }
            // Send the response to daemon; return false on failure so
            // the floating panel stays visible for retry.
            do {
                try self.daemonClient.sendConfirmationResponse(
                    requestId: requestId,
                    decision: decision
                )
            } catch {
                log.error("Failed to send confirmation response: \(error.localizedDescription)")
                return false
            }
            // Sync the inline message state across ALL ChatViewModels so the
            // originating thread is updated even if the user switched threads.
            self.mainWindow?.threadManager.updateConfirmationStateAcrossThreads(
                requestId: requestId,
                decision: decision
            )
            return true
        }
        toolConfirmationManager.onAddTrustRule = { [weak self] toolName, pattern, scope, decision in
            guard let self else { return false }
            do {
                try self.daemonClient.sendAddTrustRule(
                    toolName: toolName,
                    pattern: pattern,
                    scope: scope,
                    decision: decision
                )
                return true
            } catch {
                log.error("Failed to send add_trust_rule: \(error.localizedDescription)")
                return false
            }
        }
    }

    private func setupWindowObserver() {
        // Watch for Settings window closing to revert to accessory activation policy
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { [weak self] notification in
            // Queue is .main so we're already on the main thread
            MainActor.assumeIsolated {
                guard let self else { return }
                guard let window = notification.object as? NSWindow,
                      window.title.contains("Settings") || window.title.contains("Vellum") else { return }
                // Keep .regular if MainWindow exists; only revert for legacy menu-bar-only mode
                guard self.mainWindow == nil else { return }
                self.scheduleActivationPolicyRevert()
            }
        }
    }

    /// Revert to accessory activation policy after a short delay if no visible windows remain.
    private func scheduleActivationPolicyRevert() {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard let self else { return }
            let hasVisibleWindows = NSApp.windows.contains { $0.isVisible && $0 !== self.statusItem.button?.window }
            if !hasVisibleWindows {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            mainWindow?.show()
        }
        return true
    }

    // MARK: - Menu Bar

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Vellum")
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
        }

        let contentView = TaskInputView(onSubmit: { [weak self] submission in
            self?.startSession(submission: submission)
        }, daemonClient: daemonClient)

        popover = NSPopover()
        popover.contentSize = NSSize(width: 320, height: 200)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: contentView)
    }

    @objc private func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp {
            showContextMenu()
        } else {
            togglePopover()
        }
    }

    private func showContextMenu() {
        guard let button = statusItem.button else { return }
        let menu = NSMenu()

        let ambientEnabled = ambientAgent.isEnabled
        let ambientTitle = ambientEnabled ? "Disable Ambient Agent" : "Enable Ambient Agent"
        let ambientItem = NSMenuItem(title: ambientTitle, action: #selector(toggleAmbientAgent), keyEquivalent: "")
        ambientItem.target = self
        menu.addItem(ambientItem)

        let updateItem = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.isEnabled = updateManager.canCheckForUpdates
        menu.addItem(updateItem)

        let onboardingItem = NSMenuItem(title: "Replay Onboarding", action: #selector(replayOnboarding), keyEquivalent: "")
        onboardingItem.target = self
        menu.addItem(onboardingItem)

        #if DEBUG
        menu.addItem(NSMenuItem.separator())
        let galleryItem = NSMenuItem(title: "Component Gallery", action: #selector(showComponentGallery), keyEquivalent: "")
        galleryItem.target = self
        menu.addItem(galleryItem)
        #endif

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: 0), in: button)
    }

    @objc private func checkForUpdates() {
        updateManager.checkForUpdates()
    }

    @objc private func toggleAmbientAgent() {
        ambientAgent.isEnabled = !ambientAgent.isEnabled
        updateMenuBarIcon()
    }

    #if DEBUG
    @objc private func showComponentGallery() {
        if galleryWindow == nil { galleryWindow = ComponentGalleryWindow() }
        galleryWindow?.show()
    }
    #endif

    // MARK: - Hotkey

    private func setupHotKey() {
        hotKey = HotKey(key: .g, modifiers: [.command, .shift])
        hotKey?.keyDownHandler = { [weak self] in
            self?.togglePopover()
        }
    }

    private func setupEscapeMonitor() {
        escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { // Escape
                Task { @MainActor in
                    self?.startSessionTask?.cancel()
                    self?.thinkingWindow?.close()
                    self?.thinkingWindow = nil
                    self?.currentSession?.cancel()
                    self?.currentTextSession?.cancel()
                    self?.surfaceManager.dismissAll()
                    self?.toolConfirmationManager.dismissAll()
                }
            }
        }
    }

    // MARK: - Voice Input

    private func setupVoiceInput() {
        voiceInput = VoiceInputManager()
        voiceInput?.onTranscription = { [weak self] text in
            self?.voiceTranscriptionWindow?.close()
            self?.voiceTranscriptionWindow = nil

            // Priority 1: Route to main window ChatView if visible
            if let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                viewModel.inputText = text
                viewModel.sendMessage()
                return
            }

            // Priority 2: Route to active TextResponseWindow conversation
            if let textSession = self?.currentTextSession, textSession.state == .ready {
                textSession.sendFollowUp(text: text)
                self?.textResponseWindow?.updatePartialTranscription("")
                return
            }

            // Priority 3: Fall back to creating a new session
            self?.startSession(task: text, source: "voice")
        }
        voiceInput?.onPartialTranscription = { [weak self] text in
            // Priority 1: Route partial text to main window ChatView input if visible
            if let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                viewModel.inputText = text
                return
            }

            // Priority 2: Route to active TextResponseWindow conversation
            if let textSession = self?.currentTextSession, textSession.state == .ready {
                self?.textResponseWindow?.updatePartialTranscription(text)
            } else {
                self?.voiceTranscriptionWindow?.updateText(text)
            }
        }
        voiceInput?.onRecordingStateChanged = { [weak self] isRecording in
            // Check if main window ChatView is the target
            let mainWindowVisible = self?.mainWindow?.isVisible ?? false
            // If there's an active conversation in ready state, route recording state there
            let hasActiveConvo = self?.currentTextSession?.state == .ready

            // Sync recording state: clear on the view model that started recording
            // to avoid stale isRecording when the user switches threads mid-recording.
            if isRecording {
                self?.recordingViewModel = self?.mainWindow?.activeViewModel
            }
            if let vm = self?.recordingViewModel {
                vm.isRecording = isRecording
            }
            if !isRecording {
                self?.recordingViewModel = nil
            }

            if isRecording {
                self?.statusItem.button?.image = NSImage(
                    systemSymbolName: "mic.fill",
                    accessibilityDescription: "Vellum"
                )
                if !mainWindowVisible && !hasActiveConvo {
                    let window = VoiceTranscriptionWindow()
                    window.show()
                    self?.voiceTranscriptionWindow = window
                }
                self?.textResponseWindow?.updateRecordingState(true)
            } else {
                self?.voiceTranscriptionWindow?.close()
                self?.voiceTranscriptionWindow = nil
                self?.updateMenuBarIcon()
                self?.textResponseWindow?.updateRecordingState(false)
            }
        }
        voiceInput?.start()
    }

    // MARK: - Ambient Agent

    private func setupAmbientAgent() {
        ambientAgent.appDelegate = self
        ambientAgent.daemonClient = daemonClient

        if ambientAgent.isEnabled && daemonClient.isConnected {
            ambientAgent.start()
            updateMenuBarIcon()
        }
    }

    func updateMenuBarIcon() {
        guard statusItem != nil else { return }
        let isAmbientActive = ambientAgent.state == .watching || ambientAgent.state == .analyzing
        let iconName = isAmbientActive ? "eye" : "sparkles"
        statusItem.button?.image = NSImage(
            systemSymbolName: iconName,
            accessibilityDescription: "Vellum"
        )
    }

    @objc private func replayOnboarding() {
        guard onboardingWindow == nil else { return }
        popover.performClose(nil)

        // Ensure daemon connectivity for the interview step
        if !daemonClient.isConnected {
            setupDaemonClient()
        }

        let onboarding = OnboardingWindow(daemonClient: daemonClient)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.assistantName, forKey: "assistantName")
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil
            self?.showMainWindow()
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    // MARK: - Onboarding

    private func showOnboarding() {
        setupDaemonClient()

        let onboarding = OnboardingWindow(daemonClient: daemonClient)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
            UserDefaults.standard.set(state.assistantName, forKey: "assistantName")
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil

            self?.setupMenuBar()
            self?.setupHotKey()
            self?.setupEscapeMonitor()
            self?.setupVoiceInput()
            self?.setupAmbientAgent()
            self?.setupSurfaceManager()
            self?.setupToolConfirmationManager()
            self?.setupWindowObserver()
            self?.setupNotifications()
            self?.setupAutoUpdate()

            self?.showMainWindow()
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    private func showMainWindow() {
        if let existing = mainWindow {
            existing.show()
            return
        }
        let main = MainWindow(daemonClient: daemonClient, ambientAgent: ambientAgent)
        main.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        // Wire inline confirmation dismiss to close the corresponding floating panel
        main.threadManager.confirmationDismissHandler = { [weak self] requestId in
            self?.toolConfirmationManager.dismissConfirmation(requestId: requestId)
        }
        main.show()
        mainWindow = main
    }

    // MARK: - Settings

    /// Explicit settings window entrypoint for NSApp.sendAction("showSettingsWindow:")
    /// and direct calls from SwiftUI views. This avoids responder-chain misses.
    @objc public func showSettingsWindow(_ sender: Any?) {
        NSApp.setActivationPolicy(.regular)

        if let existing = settingsWindow {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hostingController = NSHostingController(rootView: SettingsView(ambientAgent: ambientAgent))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 450, height: 700),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Vellum Settings"
        window.contentViewController = hostingController
        window.isReleasedWhenClosed = false
        window.center()

        if let existing = settingsWindowObserver {
            NotificationCenter.default.removeObserver(existing)
            settingsWindowObserver = nil
        }

        settingsWindowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor [weak self] in
                self?.settingsWindow = nil
                if let observer = self?.settingsWindowObserver {
                    NotificationCenter.default.removeObserver(observer)
                }
                self?.settingsWindowObserver = nil
            }
        }

        settingsWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Popover

    private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: - Session

    func startSession(task: String, source: String? = nil) {
        startSession(submission: TaskSubmission(task: task, attachments: [], source: source))
    }

    func startSession(submission: TaskSubmission) {
        guard currentSession == nil && currentTextSession == nil && !isStartingSession else { return }
        isStartingSession = true
        popover.performClose(nil)

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
            try? self.daemonClient.send(TaskSubmitMessage(
                task: effectiveTask,
                screenWidth: Int(screenBounds.width),
                screenHeight: Int(screenBounds.height),
                attachments: ipcAttachments,
                source: submission.source
            ))

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
                guard ActionExecutor.checkAccessibilityPermission(prompt: true) else { return }
                let storedMaxSteps = UserDefaults.standard.integer(forKey: "maxStepsPerSession")
                let maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 50
                let session = ComputerUseSession(
                    task: effectiveTask,
                    daemonClient: self.daemonClient,
                    maxSteps: maxSteps,
                    attachments: submission.attachments,
                    sessionId: routed.sessionId,
                    skipSessionCreate: true
                )
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

    private func showDaemonConnectionError() {
        // Create a temporary session in failed state to show the error in the overlay
        let session = ComputerUseSession(
            task: "",
            daemonClient: daemonClient,
            maxSteps: 1
        )
        session.state = .failed(reason: "Cannot connect to daemon. Please ensure the daemon is running.")
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

    // MARK: - Notifications

    private func setupNotifications() {
        guard Bundle.main.bundleIdentifier != nil else { return }

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                print("Notification authorization error: \(error.localizedDescription)")
            }
        }

        let approveAction = UNNotificationAction(identifier: "APPROVE_ACTION", title: "Approve", options: [])
        let dismissAction = UNNotificationAction(identifier: "DISMISS_ACTION", title: "Dismiss", options: [])
        let automationCategory = UNNotificationCategory(
            identifier: "AUTOMATION_INSIGHT",
            actions: [approveAction, dismissAction],
            intentIdentifiers: []
        )
        center.setNotificationCategories([automationCategory])
    }

    private func registerBundledFonts() {
        for name in ["Silkscreen-Regular", "Silkscreen-Bold"] {
            guard let url = ResourceBundle.bundle.url(forResource: name, withExtension: "ttf") else {
                log.warning("Font file \(name).ttf not found in bundle")
                continue
            }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                log.warning("Failed to register font \(name): \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
            }
        }
    }

    public func applicationWillTerminate(_ notification: Notification) {
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = settingsWindowObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        voiceInput?.stop()
        ambientAgent.stop()
        surfaceManager.dismissAll()
        toolConfirmationManager.dismissAll()
        daemonLauncher.stop()
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard response.notification.request.content.categoryIdentifier == "AUTOMATION_INSIGHT",
              let insightId = userInfo["insightId"] as? String,
              let insightTitle = userInfo["insightTitle"] as? String,
              let description = userInfo["insightDescription"] as? String else {
            return
        }

        let approved: Bool
        switch response.actionIdentifier {
        case "APPROVE_ACTION":
            approved = true
        case "DISMISS_ACTION":
            approved = false
        default:
            return  // Ignore default tap and other actions
        }

        let schedule = ScheduleParser.parse(from: description)

        let decision = AutomationDecision(
            insightId: insightId,
            insightTitle: insightTitle,
            description: description,
            schedule: schedule,
            approved: approved,
            reason: nil,
            source: ProcessInfo.processInfo.hostName
        )

        let syncClient = await MainActor.run { ambientAgent.syncClient }
        await syncClient?.sendDecision(decision)
    }
}
