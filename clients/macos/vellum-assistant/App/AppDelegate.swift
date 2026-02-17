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
    var statusItem: NSStatusItem!
    private var hotKey: HotKey?
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
    private let daemonLauncher = DaemonLauncher()
    let updateManager = UpdateManager()

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
    private var settingsWindow: NSWindow?
    var bundleConfirmationWindow: BundleConfirmationWindow?
    /// Tracks file paths of .vellumapp bundles awaiting daemon responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    var pendingBundleFilePaths: [String] = []
    #if DEBUG
    var galleryWindow: ComponentGalleryWindow?
    #endif
    private var windowObserver: Any?
    private var settingsWindowObserver: Any?
    private weak var recordingViewModel: ChatViewModel?
    private var statusIconCancellable: AnyCancellable?
    var cachedSkills: [SkillInfo] = []
    var refreshSkillsTask: Task<Void, Never>?
    var cachedApps: [AppItem] = []
    var refreshAppsTask: Task<Void, Never>?

    @AppStorage("themePreference") private var themePreference: String = "system"

    public func applicationDidFinishLaunching(_ notification: Notification) {
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

        if !skipOnboarding && !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") {
            showOnboarding()
            return
        }

        startAuthenticatedFlow()
    }

    private func startAuthenticatedFlow() {
        Task {
            await authManager.checkSession()
            if authManager.isAuthenticated {
                proceedToApp()
            } else {
                showAuthWindow()
            }
        }
    }

    private var hasSetupApp = false
    private var hasSetupDaemon = false

    private func proceedToApp() {
        authWindow?.close()
        authWindow = nil

        guard !hasSetupApp else {
            showMainWindow()
            return
        }
        hasSetupApp = true

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

    private func showAuthWindow() {
        if let existing = authWindow {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let authView = AuthWindowView(
            authManager: authManager,
            onStartWithAPIKey: { [weak self] in
                self?.proceedToApp()
            },
            onAuthenticated: { [weak self] in
                self?.proceedToApp()
            }
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
            settingsWindow?.close()
            settingsWindow = nil

            hotKey = nil
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
                if let viewIndex = mainMenu.indexOfItem(withTitle: "View") as Int?,
                   viewIndex >= 0 {
                    mainMenu.removeItem(at: viewIndex)
                }
            }

            daemonLauncher.stopMonitoring()
            hasSetupApp = false
            hasSetupDaemon = false
            showAuthWindow()
        }
    }

    /// Standalone auth window shown when user needs to sign in outside of onboarding.
    /// Displays a simple "Continue with Vellum" button that triggers WorkOS AuthKit.
    @MainActor
    struct AuthWindowView: View {
        @Bindable var authManager: AuthManager
        var onStartWithAPIKey: () -> Void = {}
        var onAuthenticated: () -> Void = {}

        var body: some View {
            ZStack {
                VColor.background
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    Spacer()

                    Group {
                        if let url = ResourceBundle.bundle.url(forResource: "stage-3", withExtension: "png"),
                           let nsImage = NSImage(contentsOf: url) {
                            Image(nsImage: nsImage)
                                .resizable()
                                .interpolation(.none)
                                .aspectRatio(contentMode: .fit)
                        } else {
                            Image("VellyLogo")
                                .resizable()
                                .interpolation(.none)
                                .aspectRatio(contentMode: .fit)
                        }
                    }
                    .frame(width: 128, height: 128)
                    .padding(.bottom, VSpacing.xxl)

                    Text("Sign in to continue")
                        .font(.system(size: 32, weight: .regular, design: .serif))
                        .foregroundColor(VColor.textPrimary)
                        .padding(.bottom, VSpacing.md)

                    Text("Sign in with your Vellum account to get started.")
                        .font(.system(size: 16))
                        .foregroundColor(VColor.textSecondary)

                    Spacer()

                    VStack(spacing: VSpacing.md) {
                        Button(action: { onStartWithAPIKey() }) {
                            Text("Start with an API key")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundColor(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, VSpacing.lg)
                                .background(
                                    RoundedRectangle(cornerRadius: VRadius.lg)
                                        .fill(adaptiveColor(
                                            light: Color(nsColor: NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1)),
                                            dark: Violet._600
                                        ))
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(authManager.isSubmitting)
                        .onHover { hovering in
                            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                        }

                        Button(action: {
                            Task {
                                await authManager.startWorkOSLogin()
                                if authManager.isAuthenticated {
                                    onAuthenticated()
                                }
                            }
                        }) {
                            HStack(spacing: VSpacing.sm) {
                                if authManager.isSubmitting {
                                    ProgressView()
                                        .controlSize(.small)
                                        .progressViewStyle(.circular)
                                }
                                Text(authManager.isSubmitting ? "Signing in..." : "Continue with Vellum")
                                    .font(.system(size: 15, weight: .medium))
                            }
                            .foregroundColor(VColor.textPrimary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.lg)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .fill(adaptiveColor(light: .white, dark: VColor.surface))
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(authManager.isSubmitting)
                        .onHover { hovering in
                            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                        }

                        if let error = authManager.errorMessage {
                            Text(error)
                                .font(VFont.caption)
                                .foregroundColor(VColor.error)
                                .multilineTextAlignment(.center)
                        }
                    }
                    .padding(.horizontal, VSpacing.xxl)
                    .padding(.bottom, VSpacing.xxl)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
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

    func setupDaemonClient() {
        guard !hasSetupDaemon else { return }
        hasSetupDaemon = true

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
        daemonLauncher.onDaemonRestarted = { [weak self] in
            guard let self else { return }
            Task {
                try? await self.daemonClient.connect()
                if self.daemonClient.isConnected {
                    self.setupAmbientAgent()
                    self.refreshAppsCache()
                    self.refreshSkillsCache()
                }
            }
        }

        Task {
            // Launch the bundled daemon if present (release builds)
            try? await daemonLauncher.launchIfNeeded()
            daemonLauncher.startMonitoring()
            try? await daemonClient.connect()
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
            self?.daemonLauncher.stop()
        }
        updateManager.startAutomaticChecks()
    }

    private func setupSurfaceManager() {
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

        showMainWindow()
        return true
    }

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

            // Priority 1: Route to main window ChatView if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                viewModel.inputText = text
                viewModel.pendingVoiceMessage = true
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
            } else {
                self?.voiceTranscriptionWindow?.updateText(text)
            }
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

        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
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

        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
            UserDefaults.standard.set(state.assistantName, forKey: "assistantName")
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")
            writeVellumIdentityFile(name: state.assistantName)

            self?.writeIdentityFile(name: state.assistantName)

            onboarding.close()
            self?.onboardingWindow = nil

            if self?.authManager.isAuthenticated == true {
                self?.proceedToApp()
            } else {
                self?.startAuthenticatedFlow()
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

    // MARK: - Main Window

    func showMainWindow(initialMessage: String? = nil) {
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
            // Resume the notification service continuation with a sentinel so
            // setupToolConfirmationNotifications skips the duplicate IPC send
            // (the inline chat path already forwarded the response).
            self.toolConfirmationNotificationService.handleInlineResponse(requestId: requestId)
            // Remove the delivered notification from Notification Center
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["tool-confirm-\(requestId)"]
            )
        }
        // Send the initial message BEFORE showing the window so SwiftUI never
        // renders the empty state.
        if let message = initialMessage, let viewModel = main.activeViewModel {
            viewModel.inputText = message
            viewModel.sendMessage()
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

    // MARK: - Application Lifecycle

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
