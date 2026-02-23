import AppKit
import VellumAssistantShared
import Combine
import CoreText
import SwiftUI
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

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
    /// Shared reference — `NSApp.delegate as? AppDelegate` fails under
    /// SwiftUI's `@NSApplicationDelegateAdaptor` because SwiftUI wraps
    /// the delegate.  Use `AppDelegate.shared` instead.
    public static var shared: AppDelegate?

    var statusItem: NSStatusItem!
    private var hotKeyMonitor: Any?
    private var escapeMonitor: Any?
    var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    var currentTextSession: TextSession?
    var isStartingSession = false
    var startSessionTask: Task<Void, Never>?
    var textResponseWindow: TextResponseWindow?
    private var voiceInput: VoiceInputManager?
    private var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    var thinkingWindow: ThinkingIndicatorWindow?
    public let services = AppServices()
    private let assistantCli = AssistantCli()
    public let updateManager = UpdateManager()
    private let debugStateWriter = DebugStateWriter()

    // Forwarding accessors — ownership lives in `services`, these keep
    // existing internal references working without a mass-rename.
    var daemonClient: DaemonClient { services.daemonClient }
    var ambientAgent: AmbientAgent { services.ambientAgent }
    var surfaceManager: SurfaceManager { services.surfaceManager }
    var browserPiPManager: BrowserPiPManager { services.browserPiPManager }
    private var secretPromptManager: SecretPromptManager { services.secretPromptManager }
    var zoomManager: ZoomManager { services.zoomManager }

    let toolConfirmationNotificationService = ToolConfirmationNotificationService()

    private var onboardingWindow: OnboardingWindow?
    private var authWindow: NSWindow?
    let authManager = AuthManager()
    var mainWindow: MainWindow?
    var bundleConfirmationWindow: BundleConfirmationWindow?
    private var tasksWindow: TasksWindow?
    /// Tracks file paths of .vellumapp bundles awaiting daemon responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    var pendingBundleFilePaths: [String] = []
    #if DEBUG
    var galleryWindow: ComponentGalleryWindow?
    #endif
    private var windowObserver: Any?
    private weak var recordingViewModel: ChatViewModel?
    private var statusIconCancellable: AnyCancellable?
    var cachedSkills: [SkillInfo] = []
    var refreshSkillsTask: Task<Void, Never>?
    var cachedApps: [AppItem] = []
    var refreshAppsTask: Task<Void, Never>?

    /// Whether the current assistant runs remotely (cloud != "local").
    /// When true, local daemon hatching is skipped.
    private var isCurrentAssistantRemote = false

    @AppStorage("themePreference") private var themePreference: String = "system"

    public func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self

        // Remove stale SwiftUI Settings window frame to prevent a ghost
        // window from being restored on launch (the Settings scene now
        // renders EmptyView — we handle settings in the main window panel).
        UserDefaults.standard.removeObject(forKey: "NSWindow Frame com_apple_SwiftUI_Settings_window")

        if let envPath = FeatureFlagManager.findRepoEnvFile() {
            FeatureFlagManager.shared.loadFromFile(at: envPath)
        }

        applyThemePreference()
        registerBundledFonts()
        AvatarAppearanceManager.shared.start()

        #if DEBUG
        let skipOnboarding = CommandLine.arguments.contains("--skip-onboarding")
        #else
        let skipOnboarding = false
        #endif

        if !skipOnboarding && !lockfileHasAssistants() {
            showOnboarding()
            return
        }

        startAuthenticatedFlow()
    }

    private func startAuthenticatedFlow() {
        Task {
            await authManager.checkSession()
            if authManager.isAuthenticated || APIKeyManager.hasAnyKey() {
                proceedToApp()
            } else {
                showAuthWindow()
            }
        }
    }

    private var hasSetupApp = false
    private var hasSetupDaemon = false

    /// True while the first-launch readiness gate (`awaitDaemonReady`) is in
    /// progress.  Other entry points (`applicationShouldHandleReopen`,
    /// hotkey handler, menu bar actions) must not call `showMainWindow()`
    /// while this flag is set, because doing so would create the window
    /// without the wake-up greeting.  The readiness task clears this flag
    /// before it calls `showMainWindow(initialMessage:isFirstLaunch:)`.
    var isAwaitingFirstLaunchReady = false

    private func proceedToApp(isFirstLaunch: Bool = false) {
        authWindow?.close()
        authWindow = nil

        guard !hasSetupApp else {
            showMainWindow()
            return
        }
        hasSetupApp = true

        // On first launch (post-onboarding), the lockfile now has the
        // hatched assistant. Reset hasSetupDaemon so setupDaemonClient()
        // re-reads the lockfile, configures the correct transport (HTTP
        // for remote), and wires all callbacks to the right DaemonClient.
        if isFirstLaunch {
            hasSetupDaemon = false
        }

        setupDaemonClient()
        setupMenuBar()
        setupFileMenu()
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

        if isFirstLaunch {
            // Gate showMainWindow on daemon readiness so the wake-up
            // message isn't sent before the daemon is connected.
            // Set the flag so other entry points (dock reopen, hotkey)
            // don't create the window prematurely and swallow the greeting.
            isAwaitingFirstLaunchReady = true
            Task {
                let ready = await awaitDaemonReady(timeout: 15)
                isAwaitingFirstLaunchReady = false
                if ready {
                    showMainWindow(initialMessage: wakeUpGreeting(), isFirstLaunch: true)
                } else {
                    log.warning("Daemon not ready after timeout — opening window without wake-up greeting")
                    showMainWindow(isFirstLaunch: true)
                    mainWindow?.windowState.showToast(
                        message: "Still connecting to your assistant — it may take a moment.",
                        style: .warning
                    )
                }
                debugStateWriter.start(appDelegate: self)
            }
        } else {
            showMainWindow()
            debugStateWriter.start(appDelegate: self)
        }
    }

    /// Waits for the daemon to become connected, with bounded retries.
    ///
    /// Polls daemon connection state at ~0.5s intervals. If a connection
    /// attempt is already in flight (from `setupDaemonClient()`), waits
    /// for it to finish. Otherwise, attempts a single `connect()` call
    /// per loop iteration. Returns once connected or the timeout elapses.
    private func awaitDaemonReady(timeout: TimeInterval) async -> Bool {
        log.info("Waiting for daemon to become ready (timeout: \(timeout)s)")
        let start = CFAbsoluteTimeGetCurrent()

        while CFAbsoluteTimeGetCurrent() - start < timeout {
            if daemonClient.isConnected {
                log.info("Daemon is connected")
                return true
            }

            if daemonClient.isConnecting {
                // Let the in-flight connect from setupDaemonClient() finish
                try? await Task.sleep(nanoseconds: 500_000_000)
                continue
            }

            // Not connected and not connecting — try one connect attempt
            do {
                try await daemonClient.connect()
            } catch {
                log.error("awaitDaemonReady connect attempt failed: \(error)")
            }

            if daemonClient.isConnected {
                log.info("Daemon is connected after retry")
                return true
            }

            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        log.warning("awaitDaemonReady timed out after \(timeout)s")
        return daemonClient.isConnected
    }

    private func showAuthWindow() {
        if let existing = authWindow {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        OnboardingState.clearPersistedState()
        let state = OnboardingState()
        state.shouldPersist = false
        let authView = OnboardingFlowView(
            state: state,
            daemonClient: daemonClient,
            authManager: authManager,
            onComplete: { [weak self] in
                self?.proceedToApp()
            },
            onOpenSettings: {}
        )

        let hostingController = NSHostingController(rootView: authView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 420, height: 580)

        let startWidth: CGFloat = 460
        let startHeight: CGFloat = 620
        if let visibleFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame {
            let x = visibleFrame.midX - startWidth / 2
            let y = visibleFrame.midY - startHeight / 2
            window.setFrame(NSRect(x: x, y: y, width: startWidth, height: startHeight), display: true)
        } else {
            window.setContentSize(NSSize(width: startWidth, height: startHeight))
            window.center()
        }

        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        authWindow = window
    }

    @objc func performLogout() {
        Task {
            await authManager.logout()

            mainWindow?.close()
            mainWindow = nil

            if let hotKeyMonitor {
                NSEvent.removeMonitor(hotKeyMonitor)
                self.hotKeyMonitor = nil
            }
            if let escapeMonitor {
                NSEvent.removeMonitor(escapeMonitor)
                self.escapeMonitor = nil
            }
            voiceInput?.stop()
            voiceInput = nil
            ambientAgent.teardown()

            if let observer = windowObserver {
                NotificationCenter.default.removeObserver(observer)
                windowObserver = nil
            }
            statusIconCancellable?.cancel()
            statusIconCancellable = nil

            if let item = statusItem {
                NSStatusBar.system.removeStatusItem(item)
                statusItem = nil
            }

            if let mainMenu = NSApp.mainMenu {
                for title in ["File", "View"] {
                    let idx = mainMenu.indexOfItem(withTitle: title)
                    if idx >= 0 { mainMenu.removeItem(at: idx) }
                }
            }

            assistantCli.stopMonitoring()
            hasSetupApp = false
            hasSetupDaemon = false
            showAuthWindow()
        }
    }

    /// Switches the app to a different lockfile assistant: stops the current
    /// daemon, updates persisted state, and restarts with the new assistant.
    func performSwitchAssistant(to assistant: LockfileAssistant) {
        assistantCli.stop()
        UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
        assistant.writeToWorkspaceConfig()

        hasSetupDaemon = false
        setupDaemonClient()
    }

    @objc func performRetire() {
        Task { await performRetireAsync() }
    }

    /// Async retire implementation callable from SwiftUI so callers can
    /// await completion and dismiss their loading UI.
    ///
    /// Returns `true` if the retire completed (or the user chose to force-remove),
    /// `false` if the user cancelled after a failure.
    @discardableResult
    func performRetireAsync() async -> Bool {
        let assistantName = UserDefaults.standard.string(forKey: "connectedAssistantId")

        if assistantName == nil {
            log.error("No stored connected assistant ID found — skipping retire")
        }

        if let name = assistantName {
            do {
                try await assistantCli.retire(name: name)
            } catch {
                log.error("CLI retire failed: \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "Failed to Retire Remote Instance"
                alert.informativeText = "\(error.localizedDescription)\n\nYou can force-remove the local configuration, but the remote cloud instance may still be running and will need to be deleted manually."
                alert.alertStyle = .warning
                alert.addButton(withTitle: "Force Remove")
                alert.addButton(withTitle: "Cancel")
                if alert.runModal() != .alertFirstButtonReturn {
                    return false
                }
            }
        } else {
            assistantCli.stop()
        }

        // Check if other assistants remain in the lockfile
        let remaining = LockfileAssistant.loadAll().filter { $0.assistantId != assistantName }
        if let next = remaining.first {
            // Auto-switch to the next available assistant
            performSwitchAssistant(to: next)
            return true
        }

        // No assistants left — tear down fully and show onboarding
        OnboardingState.clearPersistedState()

        mainWindow?.close()
        mainWindow = nil

        if let hotKeyMonitor {
            NSEvent.removeMonitor(hotKeyMonitor)
            self.hotKeyMonitor = nil
        }
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
        voiceInput?.stop()
        voiceInput = nil
        ambientAgent.teardown()

        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
            windowObserver = nil
        }
        statusIconCancellable?.cancel()
        statusIconCancellable = nil

        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }

        if let mainMenu = NSApp.mainMenu {
            for title in ["File", "View"] {
                let idx = mainMenu.indexOfItem(withTitle: title)
                if idx >= 0 { mainMenu.removeItem(at: idx) }
            }
        }

        hasSetupApp = false
        hasSetupDaemon = false
        showOnboarding()
        return true
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

    /// Reads `connectedAssistantId` from UserDefaults, looks it up in the lockfile
    /// (falling back to the latest entry), and writes its config so the daemon connects
    /// to the correct assistant.
    ///
    /// Returns the loaded assistant for transport selection, or nil if none found.
    @discardableResult
    private func loadAssistantFromLockfile() -> LockfileAssistant? {
        let storedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let assistant: LockfileAssistant?

        if let storedId, let found = LockfileAssistant.loadByName(storedId) {
            assistant = found
        } else {
            assistant = LockfileAssistant.loadLatest()
        }

        guard let assistant else { return nil }

        UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
        assistant.writeToWorkspaceConfig()
        return assistant
    }

    /// Configure the daemon client's transport based on the lockfile assistant.
    /// Remote assistants (cloud != "local") use HTTP+SSE via the gateway URL.
    /// Local assistants use the default Unix domain socket, unless the
    /// `localHttpEnabled` flag redirects them to the daemon's runtime HTTP server.
    private func configureDaemonTransport(for assistant: LockfileAssistant?) {
        isCurrentAssistantRemote = assistant?.isRemote ?? false

        guard let assistant, assistant.isRemote, let runtimeUrl = assistant.runtimeUrl else {
            // Local assistant or no assistant.
            if FeatureFlagManager.shared.isEnabled(.localHttpEnabled) {
                // Use HTTP transport for the local daemon instead of IPC.
                // Bearer token is nil; resolved lazily at connect time.
                let portString = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "7821"
                let port = Int(portString) ?? 7821
                let baseURL = "http://localhost:\(port)"
                let conversationKey = assistant?.assistantId ?? UUID().uuidString
                let config = DaemonConfig(transport: .http(
                    baseURL: baseURL,
                    bearerToken: nil,
                    conversationKey: conversationKey
                ))
                services.reconfigureDaemonClient(config: config)
                log.info("Configured local HTTP transport (localHttpEnabled flag) on port \(port)")
            }
            return
        }

        let config = DaemonConfig(transport: .http(
            baseURL: runtimeUrl,
            bearerToken: assistant.bearerToken,
            conversationKey: assistant.assistantId
        ))

        // Replace the daemon client's config. Since DaemonClient.config is let,
        // we need to create a new DaemonClient with the HTTP config.
        // The services property is mutable for this purpose.
        services.reconfigureDaemonClient(config: config)

        log.info("Configured HTTP transport for remote assistant \(assistant.assistantId) at \(runtimeUrl, privacy: .public)")
    }

    func setupDaemonClient() {
        guard !hasSetupDaemon else { return }
        hasSetupDaemon = true

        let assistant = loadAssistantFromLockfile()

        // Ensure the daemon starts its runtime HTTP server so the app
        // can communicate over HTTP instead of IPC.
        if FeatureFlagManager.shared.isEnabled(.localHttpEnabled) {
            if ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] == nil {
                setenv("RUNTIME_HTTP_PORT", "7821", 0)
            }
        }

        configureDaemonTransport(for: assistant)

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

        daemonClient.onOpenTasksWindow = { [weak self] in
            self?.showTasksWindow()
        }

        // Task run threads are no longer created automatically. Users can
        // opt in via the "Open in Chat" button in the task output view.

        // Handle escalation: text_qa -> computer_use via computer_use_request_control
        daemonClient.onTaskRouted = { [weak self] routed in
            guard let self else { return }
            // Only handle escalation messages (those with escalatedFrom set)
            guard routed.escalatedFrom != nil,
                  routed.interactionType == "computer_use" else {
                log.debug("Ignoring non-escalation task_routed: type=\(routed.interactionType), escalatedFrom=\(routed.escalatedFrom ?? "nil")")
                return
            }
            self.handleEscalationToComputerUse(routed: routed)
        }

        // Forward dictation responses from the daemon to VoiceInputManager
        daemonClient.onDictationResponse = { [weak self] msg in
            self?.voiceInput?.onDictationResponse?(msg)
        }

        daemonClient.onDocumentEditorShow = { [weak self] msg in
            self?.mainWindow?.handleDocumentEditorShow(msg)
        }
        daemonClient.onDocumentEditorUpdate = { [weak self] msg in
            self?.mainWindow?.handleDocumentEditorUpdate(msg)
        }
        daemonClient.onDocumentSaveResponse = { [weak self] msg in
            self?.mainWindow?.handleDocumentSaveResponse(msg)
        }
        daemonClient.onDocumentLoadResponse = { [weak self] msg in
            self?.mainWindow?.handleDocumentLoadResponse(msg)
        }

        // Handle diagnostics export response — show a toast in the main window
        daemonClient.onDiagnosticsExportResponse = { [weak self] response in
            guard let self else { return }
            Task { @MainActor in
                if response.success, let filePath = response.filePath {
                    self.mainWindow?.windowState.showToast(
                        message: "Report exported successfully.",
                        style: .success,
                        primaryAction: VToastAction(label: "Reveal in Finder") {
                            NSWorkspace.shared.selectFile(filePath, inFileViewerRootedAtPath: "")
                        }
                    )
                } else {
                    let errorDetail = response.error ?? "Unknown error"
                    self.mainWindow?.windowState.showToast(
                        message: "Failed to export report: \(errorDetail)",
                        style: .error
                    )
                }
            }
        }

        // Restart DaemonClient connection when the health monitor relaunches
        // the daemon process so we don't wait for the backoff timer to expire.
        assistantCli.onDaemonRestarted = { [weak self] in
            guard let self else { return }
            Task {
                // Don't reset an in-progress connection attempt
                guard !self.daemonClient.isConnected, !self.daemonClient.isConnecting else { return }
                do {
                    try await self.daemonClient.connect()
                } catch {
                    log.error("Failed to reconnect to daemon after restart: \(error)")
                }
                if self.daemonClient.isConnected {
                    self.setupAmbientAgent()
                    self.refreshAppsCache()
                    self.refreshSkillsCache()
                }
            }
        }

        Task {
            if !isCurrentAssistantRemote {
                // Hatch the assistant via CLI (spawns daemon in release builds).
                // daemonOnly: true prevents creating a new lockfile entry on every launch.
                do {
                    try await assistantCli.hatch(daemonOnly: true)
                } catch {
                    log.error("Failed to hatch assistant during daemon setup: \(error)")
                }
                assistantCli.startMonitoring()
            }
            do {
                try await daemonClient.connect()
            } catch {
                log.error("Failed to connect to daemon during setup: \(error)")
            }
            // Once connected, start ambient agent if it was waiting for daemon
            if daemonClient.isConnected {
                setupAmbientAgent()
                refreshAppsCache()
                refreshSkillsCache()
            }
        }
    }

    private func setupAutoUpdate() {
        updateManager.onWillInstallUpdate = { [weak self] in
            self?.assistantCli.stop()
        }
        updateManager.startAutomaticChecks()
    }

    private func setupSurfaceManager() {
        // Let SurfaceManager check whether the standalone Tasks window is already
        // showing so it can suppress duplicate task queue surfaces from the LLM.
        surfaceManager.isTasksWindowVisible = { [weak self] in
            self?.tasksWindow?.isVisible ?? false
        }

        // Wire daemon surface messages to SurfaceManager (or BrowserPiPManager for browser_view)
        daemonClient.onSurfaceShow = { [weak self] msg in
            guard let self else { return }
            if msg.surfaceType == SurfaceType.browserView.rawValue {
                self.browserPiPManager.showPanel(for: msg)
            } else {
                self.surfaceManager.showSurface(msg)
            }
        }
        daemonClient.onSurfaceUpdate = { [weak self] msg in
            guard let self else { return }
            self.browserPiPManager.updateSurface(msg)
            self.surfaceManager.updateSurface(msg)
        }
        daemonClient.onSurfaceDismiss = { [weak self] msg in
            guard let self else { return }
            self.browserPiPManager.dismissIfMatching(surfaceId: msg.surfaceId)
            self.surfaceManager.dismissSurface(msg)
        }

        // Wire browser frame updates to BrowserPiPManager
        daemonClient.onBrowserFrame = { [weak self] msg in
            self?.browserPiPManager.updateFrame(msg)
        }

        // Wire browser interactive mode changes to BrowserPiPManager
        daemonClient.onBrowserInteractiveModeChanged = { [weak self] msg in
            self?.browserPiPManager.handleInteractiveModeChanged(msg)
        }

        // Give BrowserPiPManager a reference to DaemonClient for sending interactive input
        browserPiPManager.daemonClient = daemonClient

        daemonClient.onBrowserCDPRequest = { [weak self] msg in
            Task { @MainActor in
                await self?.handleBrowserCDPRequest(msg)
            }
        }


        // Reload webviews for surfaces whose app files changed (cross-session broadcast)
        daemonClient.onAppFilesChanged = { [weak self] appId in
            guard let self else { return }
            self.refreshAppsCache()
            for (surfaceId, appSurfaceId) in self.surfaceManager.surfaceAppIds {
                guard appSurfaceId == appId else { continue }
                self.surfaceManager.surfaceCoordinators[surfaceId]?.webView?.reload()
            }
        }

        // Wire SurfaceManager action callback to DaemonClient
        surfaceManager.onAction = { [weak self] sessionId, surfaceId, actionId, data in
            guard let self else { return }
            let codableData: [String: AnyCodable]? = data?.mapValues { AnyCodable($0) }
            do {
                try self.daemonClient.sendSurfaceAction(
                    sessionId: sessionId,
                    surfaceId: surfaceId,
                    actionId: actionId,
                    data: codableData
                )
            } catch {
                log.error("Failed to send surface action \(actionId) for surface \(surfaceId): \(error)")
            }
        }

        // Data request: JS -> Swift -> daemon
        surfaceManager.onDataRequest = { [weak self] surfaceId, callId, method, appId, recordId, data in
            guard let self else { return }
            let codableData = data?.mapValues { AnyCodable($0) }
            do {
                try self.daemonClient.send(AppDataRequestMessage(
                    surfaceId: surfaceId,
                    callId: callId,
                    method: method,
                    appId: appId,
                    recordId: recordId,
                    data: codableData
                ))
            } catch {
                log.error("Failed to send app data request (method: \(method), appId: \(appId)): \(error)")
            }
        }

        // Data response: daemon -> Swift -> JS
        daemonClient.onAppDataResponse = { [weak self] msg in
            self?.surfaceManager.resolveDataResponse(surfaceId: msg.surfaceId, response: msg)
        }

        // Link open: JS -> Swift -> daemon
        surfaceManager.onLinkOpen = { [weak self] url, metadata in
            guard let self else { return }
            let codableMetadata = metadata?.mapValues { AnyCodable($0) }
            do {
                try self.daemonClient.sendLinkOpenRequest(url: url, metadata: codableMetadata)
            } catch {
                log.error("Failed to send link open request for \(url): \(error)")
            }
        }

        // Forward layout config from daemon to MainWindowState
        daemonClient.onLayoutConfig = { [weak self] msg in
            self?.mainWindow?.windowState.applyLayoutConfig(msg)
        }

        // Route dynamic pages to workspace
        surfaceManager.onDynamicPageShow = { [weak self] msg in
            guard let self, !self.isAwaitingFirstLaunchReady else { return }
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
                // Auto-approve low/medium risk tool confirmations during CU sessions
                if self.currentSession?.autoApproveTools == true,
                   msg.riskLevel == "low" || msg.riskLevel == "medium" {
                    do {
                        try self.daemonClient.sendConfirmationResponse(
                            requestId: msg.requestId,
                            decision: "allow"
                        )
                        self.mainWindow?.threadManager.updateConfirmationStateAcrossThreads(
                            requestId: msg.requestId,
                            decision: "allow"
                        )
                    } catch {
                        log.error("Failed to auto-approve confirmation: \(error.localizedDescription)")
                    }
                    return
                }

                // Active CU sessions do not have reliable inline-chat confirmation UX.
                // Always surface permission prompts directly in the CU overlay.
                if let currentSession = self.currentSession {
                    currentSession.presentToolPermissionPrompt(msg)
                    self.overlayWindow?.bringToFront()
                    return
                }

                // When the chat window is visible AND the confirmation belongs to the
                // active thread, the inline ToolConfirmationBubble handles the
                // confirmation UX — skip the native notification to avoid showing a
                // duplicate prompt.  If the confirmation is for a background thread,
                // the inline bubble won't be visible, so we must still fire the
                // native notification.
                //
                // Important: do NOT treat a nil sessionId as "active thread". CU
                // sessions may omit the sessionId, and suppressing their prompts
                // causes the permission request to time out and auto-deny silently.
                // Also skip suppression entirely when a CU session is running —
                // CU prompts are never handled by the inline chat bubble.
                if NSApp.isActive,
                   let mainWindow = self.mainWindow,
                   mainWindow.isVisible,
                   let promptSessionId = msg.sessionId,
                   let activeSessionId = mainWindow.threadManager.activeViewModel?.sessionId,
                   promptSessionId == activeSessionId
                {
                    log.info("Suppressing native notification for confirmation \(msg.requestId) — inline bubble handles it (sessionId=\(promptSessionId))")
                    return
                }

                let decision = await self.toolConfirmationNotificationService.showConfirmation(msg)
                // If the inline chat path already forwarded the response, skip
                // the duplicate IPC send and state update.
                guard decision != ToolConfirmationNotificationService.inlineHandledSentinel else {
                    return
                }
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
            guard let statusItem = self.statusItem else { return }
            let hasVisibleWindows = NSApp.windows.contains { $0.isVisible && $0 !== statusItem.button?.window }
            if !hasVisibleWindows {
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if onboardingWindow != nil { return true }

        if authWindow != nil {
            authWindow?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return true
        }

        // Don't create the main window while the first-launch readiness
        // gate is in progress — the readiness task will create it with
        // the wake-up greeting once the daemon is connected.
        if isAwaitingFirstLaunchReady { return true }

        showMainWindow()
        return true
    }

    // MARK: - Hotkey

    private func setupHotKey() {
        // Use NSEvent global monitor instead of Carbon RegisterEventHotKey (HotKey package).
        // Carbon hotkeys consume the event globally, preventing other apps from seeing the
        // keystroke. NSEvent.addGlobalMonitorForEvents observes without consuming, so Cmd+Shift+G
        // still reaches the frontmost app.
        hotKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == [.command, .shift],
                  event.charactersIgnoringModifiers?.lowercased() == "g" else { return }
            Task { @MainActor in
                // Don't create the main window while the first-launch
                // readiness gate is in progress.
                guard self?.isAwaitingFirstLaunchReady != true else { return }
                self?.showMainWindow()
            }
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

            // Priority 1: Route to main window ChatView if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                viewModel.inputText = text
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
            // Priority 1: Route partial text to main window ChatView input if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                viewModel.inputText = text
                return
            }

            // Priority 2: Route to active TextResponseWindow conversation
            if let textSession = self?.currentTextSession, textSession.state == .ready {
                self?.textResponseWindow?.updatePartialTranscription(text)
            }
        }
        voiceInput?.daemonClient = daemonClient
        voiceInput?.onActionModeTriggered = { [weak self] text in
            guard let self else { return }
            log.info("Action mode triggered from voice dictation — submitting task")
            self.startSession(task: text, source: "voice_action")
        }
        voiceInput?.onRecordingStateChanged = { [weak self] isRecording in
            // Check if main window is actively in the foreground (not just existing behind other apps)
            let mainWindowActive = NSApp.isActive && (self?.mainWindow?.isVisible ?? false)
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
                if !mainWindowActive && !hasActiveConvo {
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

    func setupAmbientAgent() {
        ambientAgent.appDelegate = self
        ambientAgent.daemonClient = daemonClient
        // Ride Shotgun disabled — re-enable when the feature has a clearer value prop
        // ambientAgent.setupRideShotgun()
    }

    func updateMenuBarIcon() {
        guard statusItem != nil, let button = statusItem.button else { return }
        configureMenuBarIcon(button)
    }

    @objc func replayOnboarding() {
        guard onboardingWindow == nil else { return }

        // Ensure daemon connectivity for the interview step
        if !daemonClient.isConnected {
            setupDaemonClient()
        }

        // Clear persisted step so replay always starts at step 0
        OnboardingState.clearPersistedState()

        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            // Persist the assistant name in case it was changed during replay.
            let trimmedName = state.assistantName.trimmingCharacters(in: .whitespaces)
            if !trimmedName.isEmpty {
                UserDefaults.standard.set(trimmedName, forKey: "assistantName")
            }

            onboarding.close()
            self?.onboardingWindow = nil

            // Clear any stale panel state so the user lands on chat, not settings
            UserDefaults.standard.removeObject(forKey: "lastActivePanel")

            self?.showMainWindow()
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    // MARK: - Onboarding

    /// Returns `true` when `~/.vellum.lock.json` contains at least one assistant entry.
    private func lockfileHasAssistants() -> Bool {
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return false
        }
        return !assistants.isEmpty
    }

    private func showOnboarding() {
        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

            // Persist the assistant name chosen during onboarding so the
            // wake-up greeting can use it (IDENTITY.md may not be written yet).
            let trimmedName = state.assistantName.trimmingCharacters(in: .whitespaces)
            if !trimmedName.isEmpty {
                UserDefaults.standard.set(trimmedName, forKey: "assistantName")
            }

            onboarding.close()
            self?.onboardingWindow = nil

            // Clear any stale panel state so the user lands on chat, not settings
            UserDefaults.standard.removeObject(forKey: "lastActivePanel")

            // By this point the user has either entered an API key (steps 0→1→2)
            // or authenticated via Vellum Account (WorkOS). Proceed directly —
            // don't re-check auth, which would show the auth gate again.
            self?.proceedToApp(isFirstLaunch: true)
        }
        onboarding.show()
        onboardingWindow = onboarding
    }

    // MARK: - Wake-Up Greeting

    /// Generates a time-aware, name-aware greeting for the assistant's first message.
    private func wakeUpGreeting() -> String {
        let name = IdentityInfo.load()?.name
            ?? UserDefaults.standard.string(forKey: "assistantName")
            ?? "friend"

        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 5..<12:
            return "Good morning, \(name). Time to wake up."
        case 12..<18:
            return "Hey \(name), I'm here."
        case 18..<22:
            return "Evening, \(name). Ready when you are."
        default:
            // 22–4 (late night)
            return "Burning the midnight oil? Let's go, \(name)."
        }
    }

    // MARK: - Main Window

    func showMainWindow(initialMessage: String? = nil, isFirstLaunch: Bool = false) {
        if let existing = mainWindow {
            existing.show()
            return
        }
        let main = MainWindow(services: services, isFirstLaunch: isFirstLaunch)
        main.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        // Voice mode uses OpenAI Whisper + TTS directly (no VoiceInputManager needed)
        main.threadManager.onInlineConfirmationResponse = { [weak self] requestId, decision in
            guard let self else { return }
            // Resume the notification service continuation with a sentinel so
            // setupToolConfirmationNotifications skips the duplicate IPC send
            // (the inline chat path already forwarded the response).
            self.toolConfirmationNotificationService.handleInlineResponse(requestId: requestId)
            // Remove the delivered notification from Notification Center
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["tool-confirm-\(requestId)"]
            )
        }
        // On first launch, defer the wake-up message until after the
        // "coming alive" transition so the animation plays uninterrupted.
        // For non-first-launch cases, send the message immediately so
        // SwiftUI never renders the empty state.
        if let message = initialMessage {
            if isFirstLaunch {
                main.pendingWakeUpMessage = message
            } else if let viewModel = main.activeViewModel {
                viewModel.inputText = message
                viewModel.sendMessage()
            }
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

    // MARK: - About Panel

    public func showAboutPanel() {
        var options: [NSApplication.AboutPanelOptionKey: Any] = [:]

        #if DEBUG
        let bundlePath = Bundle.main.bundlePath
        let creditsString = NSMutableAttributedString()

        let headerAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.systemOrange
        ]
        creditsString.append(NSAttributedString(string: "Local Development Build\n", attributes: headerAttributes))

        let pathAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor
        ]
        creditsString.append(NSAttributedString(string: bundlePath, attributes: pathAttributes))

        options[.credits] = creditsString
        #endif

        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: options)
    }

    // MARK: - Settings

    /// Opens the settings panel in the main window.
    /// All entry points (Cmd+,, menu bar, onboarding skip, task input) use this.
    @objc public func showSettingsWindow(_ sender: Any?) {
        showMainWindow()
        mainWindow?.windowState.selection = .panel(.settings)
    }

    // MARK: - Tasks Window

    @objc func showTasksWindow() {
        NSApp.setActivationPolicy(.regular)
        if tasksWindow == nil {
            let window = TasksWindow(daemonClient: daemonClient)
            window.onOpenInChat = { [weak self] conversationId, workItemId, title in
                guard let self, !self.isAwaitingFirstLaunchReady else { return }
                self.mainWindow?.threadManager.createTaskRunThread(
                    conversationId: conversationId,
                    workItemId: workItemId,
                    title: title
                )
                if let thread = self.mainWindow?.threadManager.threads.first(where: { $0.sessionId == conversationId }) {
                    self.mainWindow?.threadManager.activeThreadId = thread.id
                }
                self.showMainWindow()
            }
            tasksWindow = window
        }
        tasksWindow?.show()
    }

    // MARK: - Application Lifecycle

    public func applicationWillTerminate(_ notification: Notification) {
        if let monitor = hotKeyMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        statusIconCancellable?.cancel()
        voiceInput?.stop()
        ambientAgent.teardown()
        surfaceManager.dismissAll()
        toolConfirmationNotificationService.dismissAll()
        secretPromptManager.dismissAll()
        debugStateWriter.stop()
        assistantCli.stop()
    }

    // MARK: - Browser CDP Request Handling

    @MainActor
    private func handleBrowserCDPRequest(_ msg: BrowserCDPRequestMessage) async {
        // Show confirmation dialog
        let alert = NSAlert()
        alert.messageText = "Browser Remote Control"
        alert.informativeText = "A separate Chrome window will open for the assistant to control. Your existing Chrome and tabs will not be affected."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open Browser")
        alert.addButton(withTitle: "Use Background Browser")

        // Add "Always launch" checkbox
        let checkbox = NSButton(checkboxWithTitle: "Always launch Chrome with remote debugging", target: nil, action: nil)
        alert.accessoryView = checkbox

        let response = alert.runModal()

        if response == .alertFirstButtonReturn {
            // Launch a separate Chrome instance for CDP (doesn't touch existing Chrome)
            let success = await ChromeAccessibilityHelper.launchChromeForCDP()

            // Handle "Always launch" checkbox
            if checkbox.state == .on {
                createChromeDebugLaunchAgent()
            }

            do {
                try daemonClient.send(BrowserCDPResponseMessage(sessionId: msg.sessionId, success: success))
            } catch {
                log.error("Failed to send browser CDP response (open): \(error)")
            }
        } else {
            // User chose background browser
            do {
                try daemonClient.send(BrowserCDPResponseMessage(sessionId: msg.sessionId, success: false, declined: true))
            } catch {
                log.error("Failed to send browser CDP response (background): \(error)")
            }
        }
    }

    /// Poll http://localhost:9222/json/version until CDP responds or we time out.
    private static func pollForCDP(maxAttempts: Int = 10, intervalNs: UInt64 = 1_000_000_000) async -> Bool {
        for _ in 0..<maxAttempts {
            try? await Task.sleep(nanoseconds: intervalNs)
            if let url = URL(string: "http://localhost:9222/json/version"),
               let (_, response) = try? await URLSession.shared.data(from: url),
               let http = response as? HTTPURLResponse,
               http.statusCode == 200 {
                return true
            }
        }
        return false
    }

    private func createChromeDebugLaunchAgent() {
        let chromeDataDir = NSHomeDirectory() + "/Library/Application Support/Google/Chrome-CDP"

        guard let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            return // Chrome not installed
        }
        let chromeBinary = chromeURL.appendingPathComponent("Contents/MacOS/Google Chrome").path

        let plistContent = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>com.vellum.chrome-debug</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(chromeBinary)</string>
                <string>--remote-debugging-port=9222</string>
                <string>--force-renderer-accessibility</string>
                <string>--user-data-dir=\(chromeDataDir)</string>
            </array>
            <key>RunAtLoad</key>
            <true/>
        </dict>
        </plist>
        """

        let launchAgentsDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents")
        let plistPath = launchAgentsDir.appendingPathComponent("com.vellum.chrome-debug.plist")

        do {
            try FileManager.default.createDirectory(at: launchAgentsDir, withIntermediateDirectories: true)
            try plistContent.write(to: plistPath, atomically: true, encoding: .utf8)
        } catch {
            // Best effort — log but don't fail
        }
    }

}
