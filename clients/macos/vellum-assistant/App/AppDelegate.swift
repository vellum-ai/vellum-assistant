import AppKit
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
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var hotKey: HotKey?
    private var escapeMonitor: Any?
    private var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    var currentTextSession: TextSession?
    private var isStartingSession = false
    private var textResponseWindow: TextResponseWindow?
    private var voiceInput: VoiceInputManager?
    private var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    private var thinkingWindow: ThinkingIndicatorWindow?
    let ambientAgent = AmbientAgent()
    let daemonClient = DaemonClient()

    private var onboardingWindow: OnboardingWindow?
    private var windowObserver: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        setupWindowObserver()
        setupNotifications()
    }

    private func setupDaemonClient() {
        Task {
            try? await daemonClient.connect()
            // Once connected, start ambient agent if it was waiting for daemon
            if daemonClient.isConnected {
                setupAmbientAgent()
            }
        }
    }

    private func setupWindowObserver() {
        // Watch for Settings window closing to revert to accessory activation policy
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let window = notification.object as? NSWindow,
                  window.title.contains("Settings") || window.title.contains("vellum") else { return }
            // Revert to accessory (no dock icon) after settings closes
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                let hasVisibleWindows = NSApp.windows.contains { $0.isVisible && $0 !== self?.statusItem.button?.window }
                if !hasVisibleWindows {
                    NSApp.setActivationPolicy(.accessory)
                }
            }
        }
    }

    // MARK: - Menu Bar

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "vellum-assistant")
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
        }

        let contentView = TaskInputView(onSubmit: { [weak self] submission in
            self?.startSession(submission: submission)
        })

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

        let onboardingItem = NSMenuItem(title: "Replay Onboarding", action: #selector(replayOnboarding), keyEquivalent: "")
        onboardingItem.target = self
        menu.addItem(onboardingItem)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: 0), in: button)
    }

    @objc private func toggleAmbientAgent() {
        ambientAgent.isEnabled = !ambientAgent.isEnabled
        updateMenuBarIcon()
    }

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
                    self?.currentSession?.cancel()
                    self?.currentTextSession?.cancel()
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
            self?.startSession(task: text)
        }
        voiceInput?.onPartialTranscription = { [weak self] text in
            self?.voiceTranscriptionWindow?.updateText(text)
        }
        voiceInput?.onRecordingStateChanged = { [weak self] isRecording in
            if isRecording {
                self?.statusItem.button?.image = NSImage(
                    systemSymbolName: "mic.fill",
                    accessibilityDescription: "vellum-assistant"
                )
                let window = VoiceTranscriptionWindow()
                window.show()
                self?.voiceTranscriptionWindow = window
            } else {
                self?.voiceTranscriptionWindow?.close()
                self?.voiceTranscriptionWindow = nil
                self?.updateMenuBarIcon()
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
        let isAmbientActive = ambientAgent.state == .watching || ambientAgent.state == .analyzing
        let iconName = isAmbientActive ? "eye" : "sparkles"
        statusItem.button?.image = NSImage(
            systemSymbolName: iconName,
            accessibilityDescription: "vellum-assistant"
        )
    }

    @objc private func replayOnboarding() {
        guard onboardingWindow == nil else { return }
        popover.performClose(nil)

        let onboarding = OnboardingWindow()
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.assistantName, forKey: "assistantName")
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil
            NSApp.setActivationPolicy(.accessory)
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    // MARK: - Onboarding

    private func showOnboarding() {
        let onboarding = OnboardingWindow()
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
            UserDefaults.standard.set(state.assistantName, forKey: "assistantName")
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            onboarding.close()
            self?.onboardingWindow = nil

            self?.setupDaemonClient()
            self?.setupMenuBar()
            self?.setupHotKey()
            self?.setupEscapeMonitor()
            self?.setupVoiceInput()
            self?.setupAmbientAgent()
            self?.setupWindowObserver()
            self?.setupNotifications()

            NSApp.setActivationPolicy(.accessory)
        }
        onboarding.show()
        onboardingWindow = onboarding
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

    func startSession(task: String) {
        startSession(submission: TaskSubmission(task: task, attachments: []))
    }

    func startSession(submission: TaskSubmission) {
        guard currentSession == nil && currentTextSession == nil && !isStartingSession else { return }
        isStartingSession = true
        popover.performClose(nil)

        let sessionTask = submission.task.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveTask = !sessionTask.isEmpty ? sessionTask : "Use the attached files as context."

        // Ensure daemon connection before starting any session
        Task { @MainActor in
            defer { self.isStartingSession = false }

            if !daemonClient.isConnected {
                log.info("Daemon not connected, attempting to connect before session start")
                do {
                    try await daemonClient.connect()
                    // Start ambient agent if it was deferred due to missing daemon connection
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

            // Classify in background
            let interactionType = await self.classifyInteraction(effectiveTask)

            // Dismiss thinking indicator
            thinking.close()
            self.thinkingWindow = nil

            switch interactionType {
            case .computerUse:
                guard ActionExecutor.checkAccessibilityPermission(prompt: true) else { return }
                let storedMaxSteps = UserDefaults.standard.integer(forKey: "maxStepsPerSession")
                let maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 50
                let session = ComputerUseSession(
                    task: effectiveTask,
                    daemonClient: self.daemonClient,
                    maxSteps: maxSteps,
                    attachments: submission.attachments,
                    interactionType: interactionType
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

            case .textQA:
                let session = TextSession(
                    task: effectiveTask,
                    daemonClient: self.daemonClient,
                    attachments: submission.attachments
                )
                self.currentTextSession = session
                let window = TextResponseWindow(session: session)
                window.show()
                self.textResponseWindow = window
                self.ambientAgent.pause()
                await session.run()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                window.close()
                self.textResponseWindow = nil
                self.currentTextSession = nil
                self.ambientAgent.resume()
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

    private func classifyInteraction(_ task: String) async -> InteractionType {
        guard let apiKey = APIKeyManager.getKey(), !apiKey.isEmpty else {
            log.warning("No API key available, falling back to heuristic classification")
            return classifyInteractionHeuristic(task)
        }

        let client = AnthropicClient(apiKey: apiKey)
        let system = "You are a classifier. Determine whether the user's request requires computer use (controlling the mouse/keyboard/apps) or is a text Q&A (answerable with text only)."
        let tools: [[String: Any]] = [[
            "name": "classify_interaction",
            "description": "Classify the user interaction type",
            "input_schema": [
                "type": "object",
                "properties": [
                    "interaction_type": [
                        "type": "string",
                        "enum": ["computer_use", "text_qa"],
                        "description": "The type of interaction"
                    ],
                    "reasoning": [
                        "type": "string",
                        "description": "Brief reasoning for the classification"
                    ]
                ],
                "required": ["interaction_type", "reasoning"]
            ] as [String: Any]
        ]]
        let toolChoice: [String: Any] = ["type": "tool", "name": "classify_interaction"]
        let messages: [[String: Any]] = [["role": "user", "content": task]]

        do {
            let result = try await client.sendToolUseRequest(
                model: "claude-haiku-4-5-20251001",
                maxTokens: 128,
                system: system,
                tools: tools,
                toolChoice: toolChoice,
                messages: messages,
                timeout: 5
            )
            let interactionTypeStr = result.input["interaction_type"] as? String ?? "computer_use"
            let reasoning = result.input["reasoning"] as? String ?? ""
            log.info("Haiku classification: \(interactionTypeStr) — \(reasoning)")
            return interactionTypeStr == "text_qa" ? .textQA : .computerUse
        } catch {
            log.warning("Haiku classification failed: \(error.localizedDescription), falling back to heuristic")
            return classifyInteractionHeuristic(task)
        }
    }

    private func classifyInteractionHeuristic(_ task: String) -> InteractionType {
        let lower = task.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)

        if lower.contains("?") { return .textQA }

        let qaStarters = ["what", "when", "where", "how", "why", "who", "which",
                          "is it", "is there", "is this", "are there", "are these",
                          "can you tell", "can you explain", "can you describe",
                          "tell me", "explain", "describe", "summarize", "list"]
        for starter in qaStarters {
            if lower.hasPrefix(starter) { return .textQA }
        }

        let cuStarters = ["open", "click", "type", "navigate", "switch", "drag", "scroll",
                          "close", "send", "fill", "submit", "go to", "move", "select",
                          "copy", "paste", "delete", "create", "write", "edit", "save",
                          "download", "upload", "install", "run", "launch", "start",
                          "stop", "press", "tap", "find", "search", "show me"]
        for starter in cuStarters {
            if lower.hasPrefix(starter) { return .computerUse }
        }

        return .computerUse
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

    func applicationWillTerminate(_ notification: Notification) {
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
        }
        voiceInput?.stop()
        ambientAgent.stop()
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
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
