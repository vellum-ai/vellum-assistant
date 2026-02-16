import AppKit
import VellumAssistantShared
import Combine
import CoreText
import HotKey
import SwiftUI
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

/// Writes `~/.vellum/workspace/IDENTITY.md` with the assistant's chosen name so the
/// daemon's system prompt includes the correct identity.
func writeVellumIdentityFile(name: String) {
    let vellumDir = NSHomeDirectory() + "/.vellum/workspace"
    let identityPath = vellumDir + "/IDENTITY.md"
    let content = """
    # IDENTITY

    - **Name:** \(name)
    - **Role:** Personal AI assistant
    """

    do {
        try FileManager.default.createDirectory(
            atPath: vellumDir,
            withIntermediateDirectories: true,
            attributes: nil
        )
        try content.write(toFile: identityPath, atomically: true, encoding: .utf8)
        log.info("Wrote IDENTITY.md for assistant name: \(name)")
    } catch {
        log.error("Failed to write IDENTITY.md: \(error.localizedDescription)")
    }
}

enum AssistantStatus {
    case idle
    case thinking
    case error(String)

    var menuTitle: String {
        switch self {
        case .idle: return "Assistant is idle"
        case .thinking: return "Assistant is thinking..."
        case .error(let msg): return "Error: \(msg)"
        }
    }

    var statusColor: NSColor {
        switch self {
        case .idle: return .systemGray
        case .thinking: return .systemGreen
        case .error: return .systemRed
        }
    }

    var statusIcon: NSImage? {
        let size: CGFloat = 8
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()
        statusColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: size, height: size)).fill()
        image.unlockFocus()
        return image
    }
}

enum InteractionType {
    case computerUse
    case textQA
}

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
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
    public let services = AppServices()
    private let daemonLauncher = DaemonLauncher()
    private let updateManager = UpdateManager()

    // Forwarding accessors — ownership lives in `services`, these keep
    // existing internal references working without a mass-rename.
    private var daemonClient: DaemonClient { services.daemonClient }
    private var ambientAgent: AmbientAgent { services.ambientAgent }
    private var surfaceManager: SurfaceManager { services.surfaceManager }
    private var secretPromptManager: SecretPromptManager { services.secretPromptManager }
    private var zoomManager: ZoomManager { services.zoomManager }

    private let toolConfirmationNotificationService = ToolConfirmationNotificationService()

    private var onboardingWindow: OnboardingWindow?
    private var mainWindow: MainWindow?
    private var settingsWindow: NSWindow?
    private var bundleConfirmationWindow: BundleConfirmationWindow?
    /// Tracks file paths of .vellumapp bundles awaiting daemon responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    private var pendingBundleFilePaths: [String] = []
    #if DEBUG
    private var galleryWindow: ComponentGalleryWindow?
    #endif
    private var windowObserver: Any?
    private var settingsWindowObserver: Any?
    private weak var recordingViewModel: ChatViewModel?
    private var statusIconCancellable: AnyCancellable?
    private var cachedSkills: [SkillInfo] = []
    private var refreshSkillsTask: Task<Void, Never>?

    @AppStorage("themePreference") private var themePreference: String = "system"

    public func applicationDidFinishLaunching(_ notification: Notification) {
        applyThemePreference()
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
        setupViewMenu()
        setupHotKey()
        setupEscapeMonitor()
        setupVoiceInput()
        setupAmbientAgent()
        setupSurfaceManager()
        setupToolConfirmationNotifications()
        setupSecretPromptManager()
        setupWindowObserver()
        setupNotifications()
        setupAutoUpdate()
        showMainWindow()
    }

    /// Applies the user's theme preference to the app appearance.
    /// Called on launch and whenever the setting changes.
    func applyThemePreference() {
        let pref = UserDefaults.standard.string(forKey: "themePreference") ?? "system"
        let appearance: NSAppearance?
        switch pref {
        case "light":
            appearance = NSAppearance(named: .aqua)
        case "dark":
            appearance = NSAppearance(named: .darkAqua)
        default:
            appearance = nil // follow system
        }

        NSApp.appearance = appearance
        for window in NSApp.windows {
            window.appearance = appearance
            window.invalidateShadow()
            window.contentView?.needsDisplay = true
        }
    }

    private func setupDaemonClient() {
        // Show macOS notification when a reminder fires
        daemonClient.onReminderFired = { msg in
            let content = UNMutableNotificationContent()
            content.title = "Reminder: \(msg.label)"
            content.body = msg.message
            content.sound = .default

            let request = UNNotificationRequest(
                identifier: "reminder-\(msg.reminderId)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { error in
                if let error {
                    log.error("Failed to post reminder notification: \(error.localizedDescription)")
                }
            }
        }

        daemonClient.onScheduleComplete = { msg in
            let content = UNMutableNotificationContent()
            content.title = msg.name
            content.sound = .default

            let request = UNNotificationRequest(
                identifier: "schedule-\(msg.scheduleId)",
                content: content,
                trigger: nil
            )
            UNUserNotificationCenter.current().add(request) { error in
                if let error {
                    log.error("Failed to post schedule notification: \(error.localizedDescription)")
                }
            }
        }

        // Handle open_bundle_response from the daemon
        daemonClient.onOpenBundleResponse = { [weak self] response in
            guard let self else { return }
            self.handleOpenBundleResponse(response)
        }

        // Refresh skills cache whenever skill state changes through any path
        daemonClient.onSkillStateChanged = { [weak self] _ in
            self?.refreshSkillsCache()
        }

        // Open URL: daemon -> Swift -> interstitial -> browser
        daemonClient.onOpenUrl = { msg in
            guard let url = URL(string: msg.url) else { return }
            let alert = NSAlert()
            alert.messageText = "Open External Link?"
            alert.informativeText = msg.url
            alert.alertStyle = .informational
            alert.addButton(withTitle: "Open in Browser")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(url)
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
                refreshSkillsCache()
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

        // Reload webviews for surfaces whose app files changed (cross-session broadcast)
        daemonClient.onAppFilesChanged = { [weak self] appId in
            guard let self else { return }
            for (surfaceId, appSurfaceId) in self.surfaceManager.surfaceAppIds {
                guard appSurfaceId == appId else { continue }
                self.surfaceManager.surfaceCoordinators[surfaceId]?.webView?.reload()
            }
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

        // Link open: JS -> Swift -> daemon
        surfaceManager.onLinkOpen = { [weak self] url, metadata in
            let codableMetadata = metadata?.mapValues { AnyCodable($0) }
            try? self?.daemonClient.sendLinkOpenRequest(url: url, metadata: codableMetadata)
        }

        // Forward layout config from daemon to MainWindowState
        daemonClient.onLayoutConfig = { [weak self] msg in
            self?.mainWindow?.windowState.applyLayoutConfig(msg)
        }

        // Route dynamic pages to workspace
        surfaceManager.onDynamicPageShow = { [weak self] msg in
            guard let self else { return }
            self.showMainWindow()
            NotificationCenter.default.post(
                name: .openDynamicWorkspace,
                object: nil,
                userInfo: ["surfaceMessage": msg]
            )
        }
    }

    private func setupToolConfirmationNotifications() {
        daemonClient.onConfirmationRequest = { [weak self] msg in
            guard let self else { return }
            Task { @MainActor in
                let decision = await self.toolConfirmationNotificationService.showConfirmation(msg)
                do {
                    try self.daemonClient.sendConfirmationResponse(
                        requestId: msg.requestId,
                        decision: decision
                    )
                    // Only sync the inline message state if the IPC send succeeded.
                    self.mainWindow?.threadManager.updateConfirmationStateAcrossThreads(
                        requestId: msg.requestId,
                        decision: decision
                    )
                } catch {
                    log.error("Failed to send confirmation response: \(error.localizedDescription)")
                }
            }
        }
    }

    private func setupSecretPromptManager() {
        daemonClient.onSecretRequest = { [weak self] msg in
            self?.secretPromptManager.showPrompt(msg)
        }
        secretPromptManager.onResponse = { [weak self] requestId, value, delivery in
            guard let self else { return false }
            do {
                try self.daemonClient.sendSecretResponse(requestId: requestId, value: value, delivery: delivery)
                return true
            } catch {
                log.error("Failed to send secret response: \(error.localizedDescription)")
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
        // Don't show the main window while onboarding is active — the app
        // isn't fully initialized yet and showing it would let users bypass
        // the onboarding flow with partially initialized state.
        guard onboardingWindow == nil else { return true }

        // Always show the main window on reopen (e.g. Spotlight, Dock click).
        // Even when hasVisibleWindows is true, the window may be behind other apps
        // and the user expects it to come to the front.
        showMainWindow()
        return true
    }

    // MARK: - Menu Bar

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            configureMenuBarIcon(button)
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
        }
    }

    private func setupViewMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }

        let viewMenu = NSMenu(title: "View")

        let zoomInItem = NSMenuItem(title: "Zoom In", action: #selector(handleZoomIn), keyEquivalent: "=")
        zoomInItem.keyEquivalentModifierMask = .command
        zoomInItem.target = self
        viewMenu.addItem(zoomInItem)

        let zoomOutItem = NSMenuItem(title: "Zoom Out", action: #selector(handleZoomOut), keyEquivalent: "-")
        zoomOutItem.keyEquivalentModifierMask = .command
        zoomOutItem.target = self
        viewMenu.addItem(zoomOutItem)

        let resetItem = NSMenuItem(title: "Actual Size", action: #selector(handleZoomReset), keyEquivalent: "0")
        resetItem.keyEquivalentModifierMask = .command
        resetItem.target = self
        viewMenu.addItem(resetItem)

        let viewMenuItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)
    }

    @objc private func handleZoomIn() { zoomManager.zoomIn() }
    @objc private func handleZoomOut() { zoomManager.zoomOut() }
    @objc private func handleZoomReset() { zoomManager.resetZoom() }

    private func configureMenuBarIcon(_ button: NSStatusBarButton) {
        let iconSize: CGFloat = 18
        let dotSize: CGFloat = 6
        let dotPadding: CGFloat = 0.5

        let appIcon = ResourceBundle.bundle.image(forResource: "MenuBarIcon")
            ?? NSImage(named: "MenuBarIcon")
            ?? NSApp.applicationIconImage
        guard let appIcon else {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Vellum")
            return
        }

        let status = currentAssistantStatus
        let dotColor = status.statusColor

        let composited = NSImage(size: NSSize(width: iconSize, height: iconSize))
        composited.lockFocus()
        appIcon.draw(
            in: NSRect(x: 0, y: 0, width: iconSize, height: iconSize),
            from: NSRect(origin: .zero, size: appIcon.size),
            operation: .copy,
            fraction: 1.0
        )
        let dotX = iconSize - dotSize - dotPadding
        let dotY = dotPadding
        let dotRect = NSRect(x: dotX, y: dotY, width: dotSize, height: dotSize)
        NSColor.black.withAlphaComponent(0.5).setFill()
        NSBezierPath(ovalIn: dotRect.insetBy(dx: -0.5, dy: -0.5)).fill()
        dotColor.setFill()
        NSBezierPath(ovalIn: dotRect).fill()
        composited.unlockFocus()
        composited.isTemplate = false
        button.image = composited
    }

    private var currentAssistantStatus: AssistantStatus {
        guard let viewModel = mainWindow?.threadManager.activeViewModel else { return .idle }
        if let error = viewModel.errorText { return .error(error) }
        if viewModel.isThinking { return .thinking }
        return .idle
    }

    @objc private func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        showStatusMenu()
    }

    private func showStatusMenu() {
        guard let button = statusItem.button else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false

        let status = currentAssistantStatus
        let statusItem = NSMenuItem(title: status.menuTitle, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        statusItem.image = status.statusIcon
        menu.addItem(statusItem)

        menu.addItem(NSMenuItem.separator())

        let currentThreadItem = NSMenuItem(title: "Current Thread", action: #selector(openCurrentThread), keyEquivalent: "")
        currentThreadItem.target = self
        currentThreadItem.image = NSImage(systemSymbolName: "message", accessibilityDescription: nil)
        menu.addItem(currentThreadItem)

        let newChatItem = NSMenuItem(title: "New Chat", action: #selector(openNewChat), keyEquivalent: "n")
        newChatItem.target = self
        newChatItem.image = NSImage(systemSymbolName: "plus.message", accessibilityDescription: nil)
        menu.addItem(newChatItem)

        let myAppsItem = NSMenuItem(title: "My Apps", action: #selector(openAppCollection), keyEquivalent: "")
        myAppsItem.target = self
        myAppsItem.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)
        menu.addItem(myAppsItem)

        menu.addItem(NSMenuItem.separator())

        // Skills submenu
        let skillsItem = NSMenuItem(title: "Skills", action: nil, keyEquivalent: "")
        skillsItem.image = NSImage(systemSymbolName: "puzzlepiece.extension", accessibilityDescription: nil)
        let skillsSubmenu = NSMenu(title: "Skills")

        let enabledSkills = cachedSkills.filter { $0.state == "enabled" }
        let disabledSkills = cachedSkills.filter { $0.state != "enabled" }

        for skill in enabledSkills {
            let emoji = skill.emoji ?? "\u{1F527}"
            let item = NSMenuItem(title: "\(emoji) \(skill.name)", action: #selector(toggleSkill(_:)), keyEquivalent: "")
            item.target = self
            item.state = .on
            item.representedObject = skill.name
            skillsSubmenu.addItem(item)
        }

        for skill in disabledSkills {
            let emoji = skill.emoji ?? "\u{1F527}"
            let item = NSMenuItem(title: "\(emoji) \(skill.name)", action: #selector(toggleSkill(_:)), keyEquivalent: "")
            item.target = self
            item.state = .off
            item.representedObject = skill.name
            skillsSubmenu.addItem(item)
        }

        if !cachedSkills.isEmpty {
            skillsSubmenu.addItem(NSMenuItem.separator())
        }

        let manageItem = NSMenuItem(title: "Manage Skills...", action: #selector(showSettingsWindow(_:)), keyEquivalent: "")
        manageItem.target = self
        skillsSubmenu.addItem(manageItem)

        skillsItem.submenu = skillsSubmenu
        menu.addItem(skillsItem)

        menu.addItem(NSMenuItem.separator())

        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(showSettingsWindow(_:)), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.image = NSImage(systemSymbolName: "gear", accessibilityDescription: nil)
        menu.addItem(settingsItem)

        menu.addItem(NSMenuItem.separator())

        let rideShotgunItem = NSMenuItem(title: "Ride Shotgun", action: #selector(showRideShotgunInvitation), keyEquivalent: "")
        rideShotgunItem.target = self
        rideShotgunItem.image = NSImage(systemSymbolName: "binoculars", accessibilityDescription: nil)
        rideShotgunItem.isEnabled = ambientAgent.currentSession == nil
        menu.addItem(rideShotgunItem)

        let updateItem = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.isEnabled = updateManager.canCheckForUpdates
        updateItem.image = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: nil)
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
        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.image = NSImage(systemSymbolName: "power", accessibilityDescription: nil)
        menu.addItem(quitItem)

        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 2), in: button)
    }

    @objc private func openCurrentThread() {
        showMainWindow()
    }

    @objc private func openNewChat() {
        showMainWindow()
        mainWindow?.threadManager.createThread()
    }

    @objc private func openAppCollection() {
        showMainWindow()
        mainWindow?.windowState.activePanel = .directory
    }

    @objc private func checkForUpdates() {
        updateManager.checkForUpdates()
    }

    @objc private func showRideShotgunInvitation() {
        ambientAgent.showInvitation()
    }

    @objc private func toggleSkill(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if sender.state == .on {
            try? daemonClient.disableSkill(name)
        } else {
            try? daemonClient.enableSkill(name)
        }
        refreshSkillsCache()
    }

    private func refreshSkillsCache() {
        // Cancel any in-flight refresh so we don't consume a stale response.
        // The new task will send its own request and wait for the next response,
        // ensuring the cache always reflects the latest daemon state.
        refreshSkillsTask?.cancel()
        refreshSkillsTask = Task {
            let stream = daemonClient.subscribe()
            do {
                try daemonClient.send(SkillsListRequestMessage())
            } catch { return }
            for await message in stream {
                guard !Task.isCancelled else { return }
                if case .skillsListResponse(let response) = message {
                    self.cachedSkills = response.skills
                    return
                }
            }
        }
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
            self?.showMainWindow()
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
                    self?.ambientAgent.resume()
                    self?.surfaceManager.dismissAll()
                    self?.toolConfirmationNotificationService.dismissAll()
                    self?.secretPromptManager.dismissAll()
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
        ambientAgent.setupRideShotgun()
    }

    func updateMenuBarIcon() {
        guard statusItem != nil, let button = statusItem.button else { return }
        configureMenuBarIcon(button)
    }

    @objc private func replayOnboarding() {
        guard onboardingWindow == nil else { return }

        // Ensure daemon connectivity for the interview step
        if !daemonClient.isConnected {
            setupDaemonClient()
        }

        let onboarding = OnboardingWindow(daemonClient: daemonClient)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.assistantName, forKey: "assistantName")
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")
            writeVellumIdentityFile(name: state.assistantName)

            self?.writeIdentityFile(name: state.assistantName)

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
            writeVellumIdentityFile(name: state.assistantName)

            self?.writeIdentityFile(name: state.assistantName)

            onboarding.close()
            self?.onboardingWindow = nil

            self?.setupMenuBar()
            self?.setupViewMenu()
            self?.setupHotKey()
            self?.setupEscapeMonitor()
            self?.setupVoiceInput()
            self?.setupAmbientAgent()
            self?.setupSurfaceManager()
            self?.setupToolConfirmationNotifications()
            self?.setupSecretPromptManager()
            self?.setupWindowObserver()
            self?.setupNotifications()
            self?.setupAutoUpdate()

            self?.showMainWindow()

            // Send an automatic greeting after onboarding completes
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                if let viewModel = self?.mainWindow?.activeViewModel {
                    viewModel.inputText = "Wake up, my friend"
                    viewModel.sendMessage()
                }
            }
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    /// Writes (or updates) `~/.vellum/workspace/IDENTITY.md` with the user-chosen assistant name.
    ///
    /// If the file already exists, only the `- **Name:** …` line is replaced so that
    /// user customizations (extra persona instructions, changed role/tone, etc.) are preserved.
    /// If the file does not exist, a fresh template is created.
    private func writeIdentityFile(name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }

        let vellumDir = NSHomeDirectory() + "/.vellum/workspace"
        let identityPath = vellumDir + "/IDENTITY.md"

        do {
            try FileManager.default.createDirectory(
                atPath: vellumDir,
                withIntermediateDirectories: true,
                attributes: nil
            )

            let content: String
            if FileManager.default.fileExists(atPath: identityPath),
               let existing = try? String(contentsOfFile: identityPath, encoding: .utf8) {
                // Replace only the Name line, preserving everything else
                let namePattern = #"^- \*\*Name:\*\*.*$"#
                if let regex = try? NSRegularExpression(pattern: namePattern, options: .anchorsMatchLines) {
                    let fullRange = NSRange(existing.startIndex..., in: existing)
                    if let match = regex.firstMatch(in: existing, range: fullRange),
                       let matchRange = Range(match.range, in: existing) {
                        var updated = existing
                        updated.replaceSubrange(matchRange, with: "- **Name:** \(trimmed)")
                        content = updated
                    } else {
                        content = existing
                    }
                } else {
                    content = existing
                }
            } else {
                content = """
                # IDENTITY

                _Customize this file to give your assistant a distinct identity._

                - **Name:** \(trimmed)
                - **Role:** Personal AI assistant
                - **Tone:** Direct, concise, and helpful
                """
            }

            try content.write(toFile: identityPath, atomically: true, encoding: .utf8)
            log.info("Wrote IDENTITY.md with name: \(trimmed)")
        } catch {
            log.error("Failed to write IDENTITY.md: \(error.localizedDescription)")
        }
    }

    private func showMainWindow() {
        if let existing = mainWindow {
            existing.show()
            return
        }
        let main = MainWindow(services: services)
        main.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        main.threadManager.onInlineConfirmationResponse = { [weak self] requestId, decision in
            guard let self else { return }
            // Resume the notification service continuation so it doesn't hang
            // (no-op if no pending request for this requestId).
            self.toolConfirmationNotificationService.handleResponse(requestId: requestId, decision: decision)
            // Remove the delivered notification from Notification Center
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["tool-confirm-\(requestId)"]
            )
        }
        main.show()
        mainWindow = main
        observeAssistantStatus()
    }

    private func observeAssistantStatus() {
        // Subscribe to active ChatViewModel's objectWillChange so menu bar icon
        // updates when isThinking or errorText changes, even though SwiftUI
        // views now use ActiveChatViewWrapper for their own observation.
        //
        // Use the emitted UUID directly (not activeViewModel) because $activeThreadId
        // fires during willSet — at that point activeThreadId still holds the old value,
        // so activeViewModel would resolve to the previous thread's view model.
        statusIconCancellable = mainWindow?.threadManager.$activeThreadId
            .compactMap { [weak mainWindow] (id: UUID?) -> ChatViewModel? in
                guard let id else { return nil }
                return mainWindow?.threadManager.chatViewModel(for: id)
            }
            .handleEvents(receiveOutput: { [weak self] _ in
                // Update immediately when switching threads
                self?.updateMenuBarIcon()
            })
            .map { $0.objectWillChange }
            .switchToLatest()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateMenuBarIcon()
            }
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

        let hostingController = NSHostingController(rootView: SettingsView(store: services.settingsStore, daemonClient: services.daemonClient))
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

        let center = UNUserNotificationCenter.current()
        center.delegate = self

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                log.error("Notification authorization error: \(error.localizedDescription)")
            }
        }

        let viewAction = UNNotificationAction(
            identifier: "VIEW_ACTIVITY",
            title: "View Results",
            options: .foreground
        )
        let activityCategory = UNNotificationCategory(
            identifier: "ACTIVITY_COMPLETE",
            actions: [viewAction],
            intentIdentifiers: [],
            options: []
        )

        let confirmAllowAction = UNNotificationAction(
            identifier: "CONFIRM_ALLOW",
            title: "Allow",
            options: []
        )
        let confirmDenyAction = UNNotificationAction(
            identifier: "CONFIRM_DENY",
            title: "Deny",
            options: []
        )
        let toolConfirmationCategory = UNNotificationCategory(
            identifier: "TOOL_CONFIRMATION",
            actions: [confirmAllowAction, confirmDenyAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        // Ride Shotgun invitation — duration choices
        let shotgun1Action = UNNotificationAction(identifier: "SHOTGUN_1MIN", title: "1 min", options: [])
        let shotgun3Action = UNNotificationAction(identifier: "SHOTGUN_3MIN", title: "3 min", options: [])
        let shotgun5Action = UNNotificationAction(identifier: "SHOTGUN_5MIN", title: "5 min", options: [])
        let rideShotgunCategory = UNNotificationCategory(
            identifier: "RIDE_SHOTGUN",
            actions: [shotgun1Action, shotgun3Action, shotgun5Action],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        center.setNotificationCategories([activityCategory, toolConfirmationCategory, rideShotgunCategory])
    }

    private func registerBundledFonts() {
        for name in ["Silkscreen-Regular", "Silkscreen-Bold", "DMMono-Regular", "DMMono-Medium", "Inter-Regular", "Inter-Medium", "Inter-SemiBold"] {
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

    // MARK: - File Open Handler

    public func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard url.pathExtension == "vellumapp" else { continue }
            log.info("Opening .vellumapp file: \(url.path)")

            guard daemonClient.isConnected else {
                log.warning("Cannot open bundle: daemon not connected")
                continue
            }

            do {
                pendingBundleFilePaths.append(url.path)
                try daemonClient.sendOpenBundle(filePath: url.path)
            } catch {
                log.error("Failed to send open_bundle message: \(error.localizedDescription)")
                // Remove the path we just appended since the send failed
                if let idx = pendingBundleFilePaths.lastIndex(of: url.path) {
                    pendingBundleFilePaths.remove(at: idx)
                }
            }
        }
    }

    // MARK: - Bundle Open Handling

    private func handleOpenBundleResponse(_ response: OpenBundleResponseMessage) {
        let filePath = pendingBundleFilePaths.isEmpty ? "" : pendingBundleFilePaths.removeFirst()

        // Check format version compatibility
        if response.manifest.formatVersion > 1 {
            let alert = NSAlert()
            alert.messageText = "Incompatible App"
            alert.informativeText = "This app requires a newer version of vellum-assistant."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        // If scan blocked, show error alert
        if !response.scanResult.passed {
            let reason = response.scanResult.blocked.first ?? "Unknown security issue"
            let alert = NSAlert()
            alert.messageText = "This app can't be opened"
            alert.informativeText = "Security scan found: \(reason)"
            alert.alertStyle = .critical
            alert.addButton(withTitle: "OK")
            alert.runModal()
            return
        }

        // Show confirmation dialog
        let viewModel = BundleConfirmationViewModel(
            response: response,
            filePath: filePath
        )

        let confirmWindow = BundleConfirmationWindow()
        self.bundleConfirmationWindow = confirmWindow

        viewModel.onConfirm = { [weak self] in
            guard let self else { return }
            confirmWindow.close()
            self.bundleConfirmationWindow = nil
            self.unpackAndLoadBundle(
                filePath: filePath,
                manifest: response.manifest,
                signatureResult: response.signatureResult,
                bundleSizeBytes: response.bundleSizeBytes
            )
        }

        viewModel.onCancel = { [weak self] in
            confirmWindow.close()
            self?.bundleConfirmationWindow = nil
        }

        confirmWindow.show(viewModel: viewModel)
    }

    private func unpackAndLoadBundle(
        filePath: String,
        manifest: OpenBundleResponseMessage.Manifest,
        signatureResult: OpenBundleResponseMessage.SignatureResult,
        bundleSizeBytes: Int
    ) {
        // Run the unzip on a background thread to avoid blocking the UI.
        Task.detached {
            do {
                let (uuid, _) = try BundleSandbox.unpack(
                    filePath: filePath,
                    manifest: manifest,
                    signatureResult: signatureResult,
                    bundleSizeBytes: bundleSizeBytes
                )

                await MainActor.run {
                    // Build the vellumapp:// URL for the entry point.
                    // Sanitize manifest.entry to prevent JS string breakout.
                    let sanitizedEntry = manifest.entry
                        .replacingOccurrences(of: "\\", with: "")
                        .replacingOccurrences(of: "'", with: "")
                    let entryURL = "\(VellumAppSchemeHandler.scheme)://\(uuid)/\(sanitizedEntry)"
                    log.info("Loading shared app at \(entryURL)")

                    // HTML-escape manifest.name to prevent XSS injection.
                    let safeName = Self.htmlEscape(manifest.name)

                    // Load the shared app as a surface via SurfaceManager
                    let surfaceId = "shared-app-\(uuid)"
                    let html = """
                    <!DOCTYPE html>
                    <html>
                    <head><meta charset="utf-8"><title>\(safeName)</title></head>
                    <body>
                        <script>window.location.href = '\(entryURL)';</script>
                    </body>
                    </html>
                    """
                    let surfaceMsg = UiSurfaceShowMessage(
                        sessionId: "shared-app",
                        surfaceId: surfaceId,
                        surfaceType: "dynamic_page",
                        title: manifest.name,
                        data: AnyCodable(["html": html]),
                        actions: nil,
                        display: "panel",
                        messageId: nil
                    )
                    self.surfaceManager.showSurface(surfaceMsg)
                }
            } catch {
                await MainActor.run {
                    log.error("Failed to unpack bundle: \(error.localizedDescription)")
                    let alert = NSAlert()
                    alert.messageText = "Failed to open app"
                    alert.informativeText = error.localizedDescription
                    alert.alertStyle = .critical
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        }
    }

    /// HTML-escape a string to prevent injection when interpolated into HTML.
    private static func htmlEscape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
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
        statusIconCancellable?.cancel()
        voiceInput?.stop()
        ambientAgent.teardown()
        surfaceManager.dismissAll()
        toolConfirmationNotificationService.dismissAll()
        secretPromptManager.dismissAll()
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
        let categoryId = response.notification.request.content.categoryIdentifier

        // Handle activity completion notifications
        if categoryId == "ACTIVITY_COMPLETE" {
            await MainActor.run {
                self.showMainWindow()
            }
            return
        }

        // Handle tool confirmation notifications
        if categoryId == "TOOL_CONFIRMATION" {
            let requestId = response.notification.request.content.userInfo["requestId"] as? String ?? ""
            let decision: String
            switch response.actionIdentifier {
            case "CONFIRM_ALLOW":
                decision = "allow"
            case "CONFIRM_DENY":
                decision = "deny"
            case UNNotificationDismissActionIdentifier:
                decision = "deny"
            default:
                // Default action (clicked banner) — deny and bring app forward
                decision = "deny"
                await MainActor.run { self.showMainWindow() }
            }
            await MainActor.run {
                self.toolConfirmationNotificationService.handleResponse(requestId: requestId, decision: decision)
            }
            return
        }

        // Handle ride shotgun invitation notifications
        if categoryId == "RIDE_SHOTGUN" {
            let durationSeconds: Int?
            switch response.actionIdentifier {
            case "SHOTGUN_1MIN":
                durationSeconds = 60
            case "SHOTGUN_3MIN":
                durationSeconds = 180
            case "SHOTGUN_5MIN":
                durationSeconds = 300
            case UNNotificationDismissActionIdentifier:
                durationSeconds = nil
            default:
                // Clicked the banner itself — start with default 3 min
                durationSeconds = 180
            }
            await MainActor.run {
                if let durationSeconds {
                    self.ambientAgent.startRideShotgun(durationSeconds: durationSeconds)
                } else {
                    self.ambientAgent.rideShotgunTrigger.recordDeclined()
                }
            }
            return
        }
    }
}
