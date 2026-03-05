import AppKit
import Carbon
import VellumAssistantShared
import Combine
import CoreText
import Sentry
import SwiftUI
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    /// Shared reference — `NSApp.delegate as? AppDelegate` fails under
    /// SwiftUI's `@NSApplicationDelegateAdaptor` because SwiftUI wraps
    /// the delegate.  Use `AppDelegate.shared` instead.
    public static var shared: AppDelegate?

    var statusItem: NSStatusItem!
    var hotKeyMonitor: Any?
    var lastRegisteredGlobalHotkey: String?
    var lastRegisteredQuickInputHotkey: String?
    var globalHotkeyObserver: AnyCancellable?
    var escapeMonitor: Any?
    var hasSetupHotKey = false
    var fnVGlobalMonitor: Any?
    var fnVLocalMonitor: Any?
    var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    var currentTextSession: TextSession?
    /// text_qa session IDs that should auto-enable CU auto-approve if they escalate.
    var autoApproveEscalationSessionIds: Set<String> = []
    var isStartingSession = false
    var startSessionTask: Task<Void, Never>?
    var textResponseWindow: TextResponseWindow?
    var voiceInput: VoiceInputManager?
    var wakeWordCoordinator: WakeWordCoordinator?
    var wakeWordErrorCancellable: AnyCancellable?
    var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    var thinkingWindow: ThinkingIndicatorWindow?
    var quickInputWindow: QuickInputWindow?
    var quickInputHotKeyRef: EventHotKeyRef?
    var quickInputEventHandlerRef: EventHandlerRef?
    var commandPaletteWindow: CommandPaletteWindow?
    var cmdKLocalMonitor: Any?
    public let services = AppServices()
    let assistantCli = AssistantCli()
    public let updateManager = UpdateManager()
    let debugStateWriter = DebugStateWriter()

    // Forwarding accessors — ownership lives in `services`, these keep
    // existing internal references working without a mass-rename.
    var daemonClient: DaemonClient { services.daemonClient }
    var ambientAgent: AmbientAgent { services.ambientAgent }
    var surfaceManager: SurfaceManager { services.surfaceManager }
    var secretPromptManager: SecretPromptManager { services.secretPromptManager }
    var zoomManager: ZoomManager { services.zoomManager }
    var conversationZoomManager: ConversationZoomManager { services.conversationZoomManager }

    let toolConfirmationNotificationService = ToolConfirmationNotificationService()
    lazy var recordingManager: RecordingManager = RecordingManager(daemonClient: daemonClient)
    var recordingPickerWindow: RecordingSourcePickerWindow?
    var recordingHUDWindow: RecordingHUDWindow?

    var onboardingWindow: OnboardingWindow?
    var authWindow: NSWindow?
    var authManager: AuthManager { services.authManager }
    public var mainWindow: MainWindow?
    var bundleConfirmationWindow: BundleConfirmationWindow?

    var pairingApprovalWindow: PairingApprovalWindow?
    /// Window shown during first-launch bootstrap when daemon is slow to start.
    var bootstrapInterstitialWindow: NSWindow?
    /// Active task for the bootstrap retry coordinator. Cancelled on dismiss.
    var bootstrapRetryTask: Task<Void, Never>?
    /// Tracks the most recent failure kind during bootstrap retries so that
    /// diagnostic messages reflect the actual problem, not generic escalating text.
    var bootstrapFailureKind: BootstrapFailureKind = .unknown
    /// Background task that retries actor-token bootstrap until success.
    var actorTokenBootstrapTask: Task<Void, Never>?
    /// Tracks file paths of .vellumapp bundles awaiting daemon responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    var pendingBundleFilePaths: [String] = []
    #if DEBUG
    var galleryWindow: ComponentGalleryWindow?
    #endif
    var windowObserver: Any?
    weak var recordingViewModel: ChatViewModel?
    /// Text that was in the chat input before PTT voice recording started,
    /// so we can prepend it to partial/final transcriptions instead of overwriting.
    var preVoiceInputText: String?
    var statusIconCancellable: AnyCancellable?
    var connectionStatusCancellable: AnyCancellable?
    var quickInputAttachmentCancellable: AnyCancellable?
    var conversationZoomEnabledCancellable: AnyCancellable?
    var conversationBadgeCancellable: AnyCancellable?
    /// Observable state for SwiftUI command group `.disabled()` modifiers.
    /// Updated via Combine subscription to `MainWindowState.objectWillChange`.
    @Published public var isConversationZoomEnabled: Bool = false
    var pulseTimer: Timer?
    var pulsePhase: CGFloat = 1.0
    var pulseDirection: CGFloat = -1.0
    var cachedSkills: [SkillInfo] = []
    var refreshSkillsTask: Task<Void, Never>?
    var cachedApps: [AppItem] = []
    var refreshAppsTask: Task<Void, Never>?
    /// Pending fallback notification tokens, keyed by conversationId.
    /// Used to avoid duplicate native alerts when notification_intent arrives.
    var pendingFallbackNotifications: [String: UUID] = [:]
    /// Recently delivered fallback notifications (epoch ms), keyed by
    /// conversationId. Incoming notification_intent for the same conversation
    /// inside a short window is treated as a duplicate and suppressed.
    var fallbackDeliveredAtMs: [String: Double] = [:]
    /// Guard to avoid repeatedly re-requesting notification authorization when
    /// multiple notification threads are created in quick succession.
    var hasRequestedNotificationAuthorizationFromThreadSignal = false
    /// Last time we surfaced the denied-notification permission toast.
    var lastNotificationPermissionToastAtMs: Double = 0

    /// Whether the current assistant runs remotely (cloud != "local").
    /// When true, local daemon hatching is skipped.
    var isCurrentAssistantRemote = false

    /// Whether the current assistant is platform-managed (cloud == "vellum").
    /// When true, actor credential bootstrap is skipped since identity is
    /// derived from the platform session, not local actor tokens.
    var isCurrentAssistantManaged = false

    @AppStorage("themePreference") private var themePreference: String = "system"

    public func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self

        // Initialize crash reporting eagerly so crashes before the daemon connects
        // are captured. Privacy opt-out is checked after the daemon is ready and
        // applied via SentrySDK.close() — matching the daemon-side pattern in
        // lifecycle.ts (init at top, close after config load if flag disabled).
        SentrySDK.start { options in
            options.dsn = "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992"
            options.debug = false
            options.tracesSampleRate = 0.1
            options.sendDefaultPii = false
        }

        // Migration: remove legacy ios-pairing-enabled flag file.
        // The old "Enable iOS Pairing" toggle created this file to expose
        // the daemon on 0.0.0.0. With QR-first pairing via gateway, the
        // flag is no longer needed and leaving it active is a security concern.
        let legacyFlagPath = NSHomeDirectory() + "/.vellum/ios-pairing-enabled"
        if FileManager.default.fileExists(atPath: legacyFlagPath) {
            try? FileManager.default.removeItem(atPath: legacyFlagPath)
        }

        // Remove stale SwiftUI Settings window frame to prevent a ghost
        // window from being restored on launch (the Settings scene now
        // renders EmptyView — we handle settings in the main window panel).
        UserDefaults.standard.removeObject(forKey: "NSWindow Frame com_apple_SwiftUI_Settings_window")


        if let envPath = MacOSClientFeatureFlagManager.findRepoEnvFile() {
            MacOSClientFeatureFlagManager.shared.loadFromFile(at: envPath)
        }

        applyThemePreference()
        registerBundledFonts()
        AvatarAppearanceManager.shared.start()

        #if DEBUG
        let skipOnboarding = CommandLine.arguments.contains("--skip-onboarding")
        #else
        let skipOnboarding = false
        #endif

        // Set up menu bar and hotkeys early so they work regardless of auth state.
        setupMenuBar()
        setupHotKey()

        if !skipOnboarding && !lockfileHasAssistants() {
            showOnboarding()
            return
        }

        startAuthenticatedFlow()
    }

    var hasSetupApp = false
    var hasSetupDaemon = false

    /// Tracks the current phase of the first-launch bootstrap sequence.
    /// Persisted in UserDefaults (`"bootstrapState"`) so the app can
    /// resume from the correct phase after a restart mid-bootstrap.
    /// Defaults to `.complete` for non-first-launch scenarios.
    var bootstrapState: BootstrapState = {
        if let raw = UserDefaults.standard.string(forKey: "bootstrapState"),
           let state = BootstrapState(rawValue: raw) {
            return state
        }
        return .complete
    }()

    /// Timestamp (CFAbsoluteTime) when the bootstrap sequence started.
    /// Used to compute stage timing metrics for observability.
    var bootstrapStartTime: CFAbsoluteTime?

    /// Whether the app is currently in the first-launch bootstrap sequence.
    /// Other entry points (dock reopen, hotkey, menu bar) must not show
    /// the main window while this is true — the bootstrap task will show
    /// it with the wake-up greeting once sequencing completes.
    var isBootstrapping: Bool { bootstrapState != .complete }

    func proceedToApp(isFirstLaunch: Bool = false) {
        authWindow?.close()
        authWindow = nil

        if !isFirstLaunch && isBootstrapping {
            log.warning("Stale bootstrap state detected on non-first-launch — resetting to complete")
            transitionBootstrap(to: .complete)
        }

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

        setupDaemonClient(isFirstLaunch: isFirstLaunch)
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
        installCLISymlinkIfNeeded()

        // Ensure actor credentials are present. On first launch this performs
        // initial bootstrap; on subsequent launches it schedules proactive
        // refresh when the access token nears expiry.
        // Skipped in managed mode where actor identity is derived from the
        // platform session, not local actor tokens.
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }

        if isFirstLaunch {
            // Enter the bootstrap state machine. The sequence is:
            // pendingDaemon → pendingWakeupSend → pendingFirstReply → complete
            // Each transition is persisted so a restart resumes correctly.
            bootstrapStartTime = CFAbsoluteTimeGetCurrent()
            transitionBootstrap(to: .pendingDaemon)
            Task {
                let ready = await awaitDaemonReady(timeout: 15)

                if ready {
                    // Daemon connected within timeout — proceed directly
                    // to mandatory wake-up send with retries.
                    transitionBootstrap(to: .pendingWakeupSend)
                    await performRetriableWakeUpSend()
                } else {
                    // Daemon not ready — show blocking interstitial instead
                    // of the chat empty state. The interstitial auto-retries
                    // daemon connection and proceeds to wake-up send once
                    // connected.
                    log.warning("Daemon not ready after timeout — showing bootstrap interstitial")
                    showBootstrapInterstitial()
                }
            }
        } else {
            showMainWindow()
            setupWakeWordCoordinator()
            debugStateWriter.start(appDelegate: self)
        }
    }

    /// Applies the user's theme preference to the app appearance.
    /// Called on launch and whenever the setting changes.

    private func setupSurfaceManager() {
        daemonClient.onSurfaceShow = { [weak self] msg in
            guard let self else { return }
            self.surfaceManager.showSurface(msg)
        }
        daemonClient.onSurfaceUpdate = { [weak self] msg in
            guard let self else { return }
            self.surfaceManager.updateSurface(msg)
        }
        daemonClient.onSurfaceDismiss = { [weak self] msg in
            guard let self else { return }
            self.surfaceManager.dismissSurface(msg)
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
            guard let self, !self.isBootstrapping else { return }
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
                // or voice-initiated text_qa sessions pending escalation
                let isVoiceAutoApprove = msg.sessionId.map { self.autoApproveEscalationSessionIds.contains($0) } ?? false
                if (self.currentSession?.autoApproveTools == true || isVoiceAutoApprove),
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

                // When the chat window is visible AND the confirmation belongs to the
                // active thread, the inline ToolConfirmationBubble handles the
                // confirmation UX — skip the native notification to avoid showing a
                // duplicate prompt.  If the confirmation is for a background thread,
                // the inline bubble won't be visible, so we must still fire the
                // native notification.
                if NSApp.isActive, let mainWindow = self.mainWindow, mainWindow.isVisible {
                    let activeSessionId = mainWindow.threadManager.activeViewModel?.sessionId
                    let confirmationIsForActiveThread = msg.sessionId == nil || msg.sessionId == activeSessionId
                    if confirmationIsForActiveThread {
                        return
                    }
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

        // Don't create the main window while bootstrap is in progress —
        // the bootstrap task will create it with the wake-up greeting
        // once the daemon is connected.
        if isBootstrapping { return true }

        showMainWindow()
        return true
    }

    // MARK: - Voice Input

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

    /// Returns `true` when `~/.vellum.lock.json` contains at least one
    /// assistant entry.
    func lockfileHasAssistants() -> Bool {
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return false
        }
        return !assistants.isEmpty
    }

    /// Check whether the local gateway is healthy by hitting its /healthz endpoint.
    /// Reads port from GATEWAY_PORT env var (default 7830) to match local.ts runtime behavior.
    func isGatewayHealthy() async -> Bool {
        let port = ProcessInfo.processInfo.environment["GATEWAY_PORT"] ?? "7830"
        guard let url = URL(string: "http://localhost:\(port)/healthz") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                return true
            }
        } catch {
            // Gateway not reachable — not healthy
        }
        return false
    }

    /// Remove a specific assistant entry from the lockfile. Used after a
    /// failed retire + Force Remove to clean up the stale entry so the
    /// next onboarding run starts with a fresh lockfile.
    func removeLockfileEntry(assistantId: String) {
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return
        }
        let filtered = assistants.filter { ($0["assistantId"] as? String) != assistantId }
        if filtered.isEmpty {
            try? FileManager.default.removeItem(at: LockfilePaths.primary)
            log.info("Removed lockfile (no entries remain after force-removing '\(assistantId, privacy: .private)')")
        } else {
            var updated = json
            updated["assistants"] = filtered
            do {
                let data = try JSONSerialization.data(withJSONObject: updated, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: LockfilePaths.primary)
                log.info("Removed stale entry '\(assistantId, privacy: .private)' from lockfile")
            } catch {
                log.error("Failed to update lockfile after removing '\(assistantId, privacy: .private)': \(error)")
            }
        }
    }

    func showOnboarding() {
        let onboarding = OnboardingWindow(daemonClient: daemonClient, authManager: authManager)
        onboarding.onComplete = { [weak self] state in
            OnboardingState.clearPersistedState()
            UserDefaults.standard.set(state.chosenKey.rawValue, forKey: "activationKey")

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

    func wakeUpGreeting() -> String {
        return "Wake up, my friend."
    }

    // MARK: - Main Window

    /// Creates the MainWindow and wires callbacks, without showing it.
    /// Safe to call multiple times — no-ops if mainWindow already exists.
    @discardableResult
    func ensureMainWindowExists(isFirstLaunch: Bool = false) -> MainWindow {
        if let existing = mainWindow { return existing }
        let main = MainWindow(services: services, isFirstLaunch: isFirstLaunch)
        main.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        main.threadManager.onInlineConfirmationResponse = { [weak self] requestId, decision in
            guard let self else { return }
            self.toolConfirmationNotificationService.handleInlineResponse(requestId: requestId)
            UNUserNotificationCenter.current().removeDeliveredNotifications(
                withIdentifiers: ["tool-confirm-\(requestId)"]
            )
        }
        mainWindow = main
        observeConversationZoomEnabled(main.windowState)
        observeAssistantStatus()
        observeConversationBadge(main.threadManager)
        return main
    }

    /// Subscribe to `MainWindowState` changes and keep `isConversationZoomEnabled`
    /// in sync so SwiftUI command groups can observe it via `@Published`.
    private func observeConversationZoomEnabled(_ windowState: MainWindowState) {
        conversationZoomEnabledCancellable = windowState.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self, weak windowState] _ in
                guard let self, let windowState else { return }
                // objectWillChange fires before the new value is set,
                // so defer the read to the next run-loop tick.
                DispatchQueue.main.async {
                    let enabled = windowState.isConversationVisible
                    if self.isConversationZoomEnabled != enabled {
                        self.isConversationZoomEnabled = enabled
                    }
                }
            }
        // Set initial value.
        isConversationZoomEnabled = windowState.isConversationVisible
    }

    func showMainWindow(initialMessage: String? = nil, isFirstLaunch: Bool = false) {
        // Centralized bootstrap guard: non-first-launch callers (dock reopen,
        // hotkey, menu bar) must not create the window during bootstrap.
        // The bootstrap task itself passes isFirstLaunch: true to bypass this.
        if isBootstrapping && !isFirstLaunch { return }

        if let existing = mainWindow {
            existing.show()
            refreshDockConversationBadge()
            return
        }
        let main = ensureMainWindowExists(isFirstLaunch: isFirstLaunch)
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
        refreshDockConversationBadge()
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

    private func observeConversationBadge(_ threadManager: ThreadManager) {
        conversationBadgeCancellable?.cancel()

        applyDockConversationBadge(count: threadManager.unseenVisibleConversationCount)

        conversationBadgeCancellable = threadManager.$threads
            .map { threads in threads.filter { !$0.isArchived && $0.kind != .private && $0.hasUnseenLatestAssistantMessage }.count }
            .removeDuplicates()
            .sink { [weak self] count in
                self?.applyDockConversationBadge(count: count)
            }
    }

    /// Format the unseen conversation count for the dock badge.
    /// Returns nil for 0 (clears badge), exact string for 1-99, "99+" for 100+.
    func formatDockConversationBadge(count: Int) -> String? {
        if count <= 0 { return nil }
        if count >= 100 { return "99+" }
        return "\(count)"
    }

    private func applyDockConversationBadge(count: Int) {
        NSApp.dockTile.badgeLabel = formatDockConversationBadge(count: count)
        // Activation-policy transitions can recreate Dock tile presentation;
        // force a redraw so badge updates are immediately reflected.
        NSApp.dockTile.display()
    }

    private func refreshDockConversationBadge() {
        applyDockConversationBadge(count: mainWindow?.threadManager.unseenVisibleConversationCount ?? 0)
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

    /// Opens the settings panel and navigates to a specific tab.
    public func showSettingsTab(_ tab: String) {
        if let settingsTab = SettingsTab.fromLegacyRawValue(tab, isDevMode: services.settingsStore.isDevMode) {
            services.settingsStore.pendingSettingsTab = settingsTab
        }
        showSettingsWindow(nil)
    }

    // MARK: - Application Lifecycle

    public func applicationWillTerminate(_ notification: Notification) {
        if let monitor = hotKeyMonitor {
            NSEvent.removeMonitor(monitor)
        }
        tearDownQuickInputMonitors()
        globalHotkeyObserver?.cancel()
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
        }
        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        statusIconCancellable?.cancel()
        conversationBadgeCancellable?.cancel()
        NSApp.dockTile.badgeLabel = nil
        connectionStatusCancellable?.cancel()
        pulseTimer?.invalidate()
        pulseTimer = nil
        voiceInput?.stop()
        ambientAgent.teardown()
        surfaceManager.dismissAll()
        toolConfirmationNotificationService.dismissAll()
        secretPromptManager.dismissAll()
        recordingManager.forceStop()
        recordingHUDWindow?.dismiss()
        debugStateWriter.stop()
        assistantCli.stop()
    }

}
