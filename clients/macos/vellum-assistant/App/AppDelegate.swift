import AppKit
import SwiftUI
import HotKey
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var hotKey: HotKey?
    private var escapeMonitor: Any?
    private var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    private var voiceInput: VoiceInputManager?
    private var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    let ambientAgent = AmbientAgent()
    let auth0Manager = Auth0Manager()

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

        setupMenuBar()
        setupHotKey()
        setupEscapeMonitor()
        setupVoiceInput()
        setupAmbientAgent()
        setupWindowObserver()
        setupNotifications()
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

        let contentView = TaskInputView(onSubmit: { [weak self] task in
            self?.startSession(task: task)
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
        if ambientAgent.isEnabled {
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
        guard currentSession == nil else { return }
        popover.performClose(nil)

        guard let apiKey = APIKeyManager.getKey() else {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            return
        }

        guard ActionExecutor.checkAccessibilityPermission(prompt: true) else {
            return
        }

        let provider = AnthropicProvider(apiKey: apiKey)
        let storedMaxSteps = UserDefaults.standard.integer(forKey: "maxStepsPerSession")
        let maxSteps = storedMaxSteps > 0 ? storedMaxSteps : 50
        let session = ComputerUseSession(task: task, provider: provider, maxSteps: maxSteps)
        currentSession = session

        let overlay = SessionOverlayWindow(session: session)
        overlay.show()
        overlayWindow = overlay

        ambientAgent.pause()

        Task { @MainActor in
            await session.run()
            try? await Task.sleep(nanoseconds: 10_000_000_000) // 10s for undo opportunity
            overlay.close()
            self.overlayWindow = nil
            self.currentSession = nil
            self.ambientAgent.resume()
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
            source: "alexs-macbook-pro-2"
        )

        let syncClient = await MainActor.run { ambientAgent.syncClient }
        await syncClient?.sendDecision(decision)
    }
}
