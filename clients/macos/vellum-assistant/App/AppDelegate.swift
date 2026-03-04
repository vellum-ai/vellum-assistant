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

/// Tracks the first-launch bootstrap sequence so the app can resume
/// from the correct phase after a restart mid-bootstrap.
/// Raw values are persisted in UserDefaults under `"bootstrapState"`.
enum BootstrapState: String {
    case pendingDaemon = "pendingDaemon"
    case pendingWakeupSend = "pendingWakeupSend"
    case pendingFirstReply = "pendingFirstReply"
    case complete = "complete"
}

/// Categorises the most recent bootstrap failure so diagnostic messages
/// can be specific rather than generic escalating text.
private enum BootstrapFailureKind {
    case socketMissing
    case daemonNotRunning
    case connectionRefused
    case gatewayUnhealthy
    case authFailed
    case unknown
}

/// Carbon event handler for the Quick Input hotkey (Cmd+Shift+/).
/// Must be a free function because Carbon callbacks are C function pointers.
private func quickInputHotKeyHandler(
    _: EventHandlerCallRef?,
    event: EventRef?,
    _: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event else { return OSStatus(eventNotHandledErr) }

    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    guard status == noErr, hotKeyID.id == 1 else { return OSStatus(eventNotHandledErr) }

    Task { @MainActor in
        guard let appDelegate = AppDelegate.shared,
              !appDelegate.isBootstrapping else { return }
        appDelegate.toggleQuickInput()
    }
    return noErr
}

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate, ObservableObject {
    /// Shared reference — `NSApp.delegate as? AppDelegate` fails under
    /// SwiftUI's `@NSApplicationDelegateAdaptor` because SwiftUI wraps
    /// the delegate.  Use `AppDelegate.shared` instead.
    public static var shared: AppDelegate?

    var statusItem: NSStatusItem!
    private var hotKeyMonitor: Any?
    private var lastRegisteredGlobalHotkey: String?
    private var lastRegisteredQuickInputHotkey: String?
    private var globalHotkeyObserver: AnyCancellable?
    private var escapeMonitor: Any?
    private var fnVGlobalMonitor: Any?
    private var fnVLocalMonitor: Any?
    var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    var currentTextSession: TextSession?
    /// text_qa session IDs that should auto-enable CU auto-approve if they escalate.
    var autoApproveEscalationSessionIds: Set<String> = []
    var isStartingSession = false
    var startSessionTask: Task<Void, Never>?
    var textResponseWindow: TextResponseWindow?
    var voiceInput: VoiceInputManager?
    private var wakeWordCoordinator: WakeWordCoordinator?
    private var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    var thinkingWindow: ThinkingIndicatorWindow?
    private var quickInputWindow: QuickInputWindow?
    private var quickInputHotKeyRef: EventHotKeyRef?
    private var quickInputEventHandlerRef: EventHandlerRef?
    private var commandPaletteWindow: CommandPaletteWindow?
    private var cmdKLocalMonitor: Any?
    public let services = AppServices()
    let assistantCli = AssistantCli()
    public let updateManager = UpdateManager()
    private let debugStateWriter = DebugStateWriter()

    // Forwarding accessors — ownership lives in `services`, these keep
    // existing internal references working without a mass-rename.
    var daemonClient: DaemonClient { services.daemonClient }
    var ambientAgent: AmbientAgent { services.ambientAgent }
    var surfaceManager: SurfaceManager { services.surfaceManager }
    private var secretPromptManager: SecretPromptManager { services.secretPromptManager }
    var zoomManager: ZoomManager { services.zoomManager }
    var conversationZoomManager: ConversationZoomManager { services.conversationZoomManager }

    let toolConfirmationNotificationService = ToolConfirmationNotificationService()
    lazy var recordingManager: RecordingManager = RecordingManager(daemonClient: daemonClient)
    var recordingPickerWindow: RecordingSourcePickerWindow?
    var recordingHUDWindow: RecordingHUDWindow?

    private var onboardingWindow: OnboardingWindow?
    private var authWindow: NSWindow?
    var authManager: AuthManager { services.authManager }
    public var mainWindow: MainWindow?
    var bundleConfirmationWindow: BundleConfirmationWindow?

    var pairingApprovalWindow: PairingApprovalWindow?
    /// Window shown during first-launch bootstrap when daemon is slow to start.
    private var bootstrapInterstitialWindow: NSWindow?
    /// Active task for the bootstrap retry coordinator. Cancelled on dismiss.
    private var bootstrapRetryTask: Task<Void, Never>?
    /// Tracks the most recent failure kind during bootstrap retries so that
    /// diagnostic messages reflect the actual problem, not generic escalating text.
    private var bootstrapFailureKind: BootstrapFailureKind = .unknown
    /// Background task that retries actor-token bootstrap until success.
    private var actorTokenBootstrapTask: Task<Void, Never>?
    /// Tracks file paths of .vellumapp bundles awaiting daemon responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    var pendingBundleFilePaths: [String] = []
    #if DEBUG
    var galleryWindow: ComponentGalleryWindow?
    #endif
    private var windowObserver: Any?
    private weak var recordingViewModel: ChatViewModel?
    /// Text that was in the chat input before PTT voice recording started,
    /// so we can prepend it to partial/final transcriptions instead of overwriting.
    private var preVoiceInputText: String?
    var statusIconCancellable: AnyCancellable?
    var connectionStatusCancellable: AnyCancellable?
    private var quickInputAttachmentCancellable: AnyCancellable?
    private var conversationZoomEnabledCancellable: AnyCancellable?
    private var conversationBadgeCancellable: AnyCancellable?
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
    private var bootstrapStartTime: CFAbsoluteTime?

    /// Whether the app is currently in the first-launch bootstrap sequence.
    /// Other entry points (dock reopen, hotkey, menu bar) must not show
    /// the main window while this is true — the bootstrap task will show
    /// it with the wake-up greeting once sequencing completes.
    var isBootstrapping: Bool { bootstrapState != .complete }

    /// Persists the current bootstrap state to UserDefaults.
    private func persistBootstrapState() {
        UserDefaults.standard.set(bootstrapState.rawValue, forKey: "bootstrapState")
    }

    /// Transitions to a new bootstrap state, persists it, and emits stage timing logs.
    private func transitionBootstrap(to newState: BootstrapState) {
        log.info("Bootstrap state: \(self.bootstrapState.rawValue) → \(newState.rawValue)")
        bootstrapState = newState
        persistBootstrapState()

        // Emit stage timing when a start timestamp is available.
        if let start = bootstrapStartTime {
            let elapsedMs = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
            switch newState {
            case .pendingWakeupSend:
                log.info("bootstrap.daemon_ready_ms: \(elapsedMs)")
            case .pendingFirstReply:
                log.info("bootstrap.wakeup_sent_ms: \(elapsedMs)")
            case .complete:
                log.info("bootstrap.first_reply_ms: \(elapsedMs)")
            case .pendingDaemon:
                break
            }
        }
    }

    private func proceedToApp(isFirstLaunch: Bool = false) {
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

    /// Polls daemon connection state at ~0.5s intervals. Does NOT call
    /// `connect()` itself — that is the sole responsibility of
    /// `setupDaemonClient()`. This avoids a dual-connect race where two
    /// concurrent Tasks both attempt `daemonClient.connect()`, with the
    /// second caller's `disconnectInternal()` tearing down the first
    /// caller's in-flight NWConnection.
    private func awaitDaemonReady(timeout: TimeInterval) async -> Bool {
        log.info("Waiting for daemon to become ready (timeout: \(timeout)s)")
        let start = CFAbsoluteTimeGetCurrent()

        while CFAbsoluteTimeGetCurrent() - start < timeout {
            if daemonClient.isConnected {
                log.info("Daemon is connected")
                return true
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        log.warning("awaitDaemonReady timed out after \(timeout)s")
        return daemonClient.isConnected
    }

    // MARK: - Bootstrap Interstitial

    /// Shows a blocking interstitial window during first-launch bootstrap when
    /// the daemon is slow to start. The interstitial auto-retries daemon
    /// connection every 2 seconds and transitions to the chat with the wake-up
    /// greeting once the daemon connects.
    private func showBootstrapInterstitial() {
        guard bootstrapInterstitialWindow == nil else { return }

        let interstitialView = BootstrapInterstitialView(
            isRetrying: true,
            onRetry: { [weak self] in
                self?.bootstrapInterstitialRetry()
            }
        )

        let hostingController = NSHostingController(rootView: interstitialView)
        hostingController.sizingOptions = []  // Prevent auto-resizing from SwiftUI
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 300),
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 380, height: 300))
        window.center()

        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        bootstrapInterstitialWindow = window

        // Start auto-retry polling for daemon readiness
        startBootstrapRetryCoordinator()
    }

    /// Updates the interstitial view content (error message and retry state).
    private func updateBootstrapInterstitial(errorMessage: String? = nil, isRetrying: Bool = true) {
        guard let window = bootstrapInterstitialWindow else { return }

        let updatedView = BootstrapInterstitialView(
            errorMessage: errorMessage,
            isRetrying: isRetrying,
            onRetry: { [weak self] in
                self?.bootstrapInterstitialRetry()
            }
        )
        let hostingController = NSHostingController(rootView: updatedView)
        hostingController.sizingOptions = []  // Prevent auto-resizing from SwiftUI
        window.contentViewController = hostingController
    }

    /// Dismisses the bootstrap interstitial window and cancels any retry tasks.
    /// Use this for external cleanup callers that need to stop the retry loop.
    private func dismissBootstrapInterstitial() {
        bootstrapRetryTask?.cancel()
        bootstrapRetryTask = nil
        bootstrapInterstitialWindow?.close()
        bootstrapInterstitialWindow = nil
    }

    /// Closes only the interstitial window without cancelling the retry task.
    /// Use this from within `startBootstrapRetryCoordinator()` to avoid
    /// self-cancellation when the task dismisses the window upon success.
    private func dismissBootstrapInterstitialWindow() {
        bootstrapInterstitialWindow?.close()
        bootstrapInterstitialWindow = nil
    }

    /// Manual retry triggered by the "Try Again" button in the interstitial.
    private func bootstrapInterstitialRetry() {
        bootstrapRetryTask?.cancel()
        startBootstrapRetryCoordinator()
    }

    /// Starts a background task that polls daemon readiness every 2 seconds.
    /// When the daemon connects, dismisses the interstitial and proceeds
    /// with the mandatory wake-up send. Shows escalating diagnostic messages
    /// if the daemon takes too long to connect.
    private func startBootstrapRetryCoordinator() {
        bootstrapRetryTask?.cancel()
        updateBootstrapInterstitial(isRetrying: true)

        let retryStart = CFAbsoluteTimeGetCurrent()

        bootstrapRetryTask = Task {
            while !Task.isCancelled {
                // Reset so the displayed message always reflects the most
                // recent failure, not a stale one from a previous iteration.
                bootstrapFailureKind = .unknown

                if daemonClient.isConnected {
                    // Daemon is connected — check gateway health before proceeding.
                    // Remote assistants don't run a local gateway, so skip the check.
                    let gatewayHealthy = await isGatewayHealthy()
                    let gatewayOk = isCurrentAssistantRemote || gatewayHealthy
                    if !gatewayOk {
                        // Gateway is unhealthy but daemon is connected. Record for
                        // diagnostics but proceed anyway — the gateway being down
                        // only affects external ingress (Twilio, OAuth), not core
                        // assistant functionality. Blocking here causes a deadlock
                        // when the lockfile-exists fallback hatches with daemonOnly.
                        bootstrapFailureKind = .gatewayUnhealthy
                        log.warning("Gateway unhealthy during bootstrap retry but daemon is connected — proceeding anyway (some features like Twilio/OAuth ingress may be unavailable)")
                    } else {
                        log.info("Daemon connected during bootstrap retry — proceeding to wake-up send")
                    }
                    transitionBootstrap(to: .pendingWakeupSend)
                    dismissBootstrapInterstitialWindow()
                    await performRetriableWakeUpSend()
                    if !Task.isCancelled {
                        bootstrapRetryTask = nil
                    }
                    return
                }

                // If the daemon socket doesn't exist, the daemon process
                // likely isn't running (e.g. hatch failed). Re-attempt hatch
                // so we don't loop forever on connect-only retries.
                // Managed mode skips local hatch — the platform hosts the daemon.
                if !isCurrentAssistantManaged {
                    let socketPath = DaemonClient.resolveSocketPath()
                    if !FileManager.default.fileExists(atPath: socketPath) {
                        bootstrapFailureKind = .socketMissing
                        log.info("Daemon socket missing during bootstrap retry — re-attempting hatch")
                        try? await assistantCli.hatch(daemonOnly: true)
                    } else if !DaemonClient.isDaemonProcessAlive() {
                        bootstrapFailureKind = .daemonNotRunning
                        log.info("Daemon process not alive during bootstrap retry — re-attempting hatch")
                        try? await assistantCli.hatch(daemonOnly: true)
                    }
                }

                // Attempt a connection if not already connected or in progress.
                if !daemonClient.isConnected && !daemonClient.isConnecting {
                    do {
                        try await daemonClient.connect()
                    } catch {
                        if bootstrapFailureKind == .unknown {
                            if error is DaemonClient.AuthError {
                                bootstrapFailureKind = .authFailed
                            } else {
                                bootstrapFailureKind = .connectionRefused
                            }
                        }
                        log.error("Bootstrap retry connect attempt failed: \(error)")
                    }
                }

                if daemonClient.isConnected {
                    // Connected — verify gateway health before proceeding.
                    // Remote assistants don't run a local gateway, so skip the check.
                    let gatewayHealthy = await isGatewayHealthy()
                    let gatewayOk = isCurrentAssistantRemote || gatewayHealthy
                    if !gatewayOk {
                        // Same rationale as the check above: gateway health is a
                        // warning, not a gate. Blocking here deadlocks when hatch
                        // ran with daemonOnly (lockfile-exists fallback).
                        bootstrapFailureKind = .gatewayUnhealthy
                        log.warning("Gateway unhealthy after bootstrap retry connect but daemon is connected — proceeding anyway (some features like Twilio/OAuth ingress may be unavailable)")
                    } else {
                        log.info("Daemon connected after bootstrap retry connect — proceeding to wake-up send")
                    }
                    transitionBootstrap(to: .pendingWakeupSend)
                    dismissBootstrapInterstitialWindow()
                    await performRetriableWakeUpSend()
                    if !Task.isCancelled {
                        bootstrapRetryTask = nil
                    }
                    return
                }

                // Surface diagnostics so the user isn't staring at a
                // spinner with no context.
                let elapsed = CFAbsoluteTimeGetCurrent() - retryStart
                if elapsed > 30 {
                    updateBootstrapInterstitial(
                        errorMessage: bootstrapDiagnosticMessage(elapsed: elapsed),
                        isRetrying: true
                    )
                }

                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// Returns a user-facing diagnostic message based on the current failure
    /// kind and how long the bootstrap retry has been running.
    private func bootstrapDiagnosticMessage(elapsed: CFAbsoluteTime) -> String {
        switch bootstrapFailureKind {
        case .socketMissing:
            if elapsed > 60 {
                return "Assistant files are missing. Try quitting (\u{2318}Q) and reopening."
            }
            return "Restarting your assistant\u{2026}"

        case .daemonNotRunning:
            if elapsed > 60 {
                return "Unable to restart assistant. Try quitting (\u{2318}Q) and reopening."
            }
            return "Assistant process stopped \u{2014} restarting\u{2026}"

        case .connectionRefused:
            if elapsed > 60 {
                return "Connection keeps failing. Try quitting (\u{2318}Q) and reopening."
            }
            return "Connecting to your assistant\u{2026}"

        case .gatewayUnhealthy:
            if elapsed > 60 {
                return "Network services are not responding. Try quitting (\u{2318}Q) and reopening."
            }
            return "Waiting for network services\u{2026}"

        case .authFailed:
            if elapsed > 60 {
                return "Authentication issue. You may need to re-pair your assistant."
            }
            return "Authenticating\u{2026}"

        case .unknown:
            if elapsed > 120 {
                return "Your assistant is taking unusually long to start. "
                    + "Try quitting the app (\u{2318}Q) and reopening it. "
                    + "If the issue persists, retire and re-hatch your assistant."
            } else if elapsed > 60 {
                return "This is taking longer than expected. "
                    + "A background process may have crashed. "
                    + "The app will keep retrying automatically."
            } else {
                return "Still working on it \u{2014} this can take a minute on first launch."
            }
        }
    }

    /// Sends the wake-up greeting. If the daemon is disconnected, waits for
    /// reconnection before proceeding. Since `showMainWindow` always creates
    /// the window (via `ensureMainWindowExists`), there is no need for a
    /// retry loop — a simple guard suffices.
    private func performRetriableWakeUpSend() async {
        guard !Task.isCancelled else { return }

        // If daemon disconnected, wait for reconnection before trying
        if !daemonClient.isConnected {
            log.warning("Daemon disconnected during wake-up send — waiting for reconnection")
            let reconnected = await awaitDaemonReady(timeout: 15)
            if !reconnected {
                log.warning("Daemon did not reconnect — showing interstitial for manual retry")
                showBootstrapInterstitial()
                updateBootstrapInterstitial(
                    errorMessage: "Lost connection to your assistant. Retrying...",
                    isRetrying: true
                )
                return
            }
        }

        let greeting = wakeUpGreeting()
        showMainWindow(initialMessage: greeting, isFirstLaunch: true)

        // showMainWindow always creates mainWindow, but guard defensively.
        guard let main = mainWindow else {
            log.error("MainWindow not created after showMainWindow — cannot send wake-up")
            showBootstrapInterstitial()
            updateBootstrapInterstitial(
                errorMessage: "Could not start your assistant. Please try again.",
                isRetrying: false
            )
            return
        }

        log.info("MainWindow created — deferring pendingFirstReply until wake-up message is dispatched")
        main.onWakeUpSent = { [weak self] in
            guard let self else { return }
            log.info("Wake-up greeting actually sent — transitioning to pendingFirstReply")
            self.transitionBootstrap(to: .pendingFirstReply)
            self.wireBootstrapFirstReplyCallback()
        }
        setupWakeWordCoordinator()
        debugStateWriter.start(appDelegate: self)
    }

    /// Wires `onFirstAssistantReply` on the active ChatViewModel so bootstrap
    /// transitions to `.complete` when the daemon's first reply arrives.
    private func wireBootstrapFirstReplyCallback() {
        guard let viewModel = mainWindow?.activeViewModel else {
            log.warning("No active ChatViewModel to wire first-reply callback — completing bootstrap immediately")
            transitionBootstrap(to: .complete)
            return
        }
        viewModel.onFirstAssistantReply = { [weak self] _ in
            self?.transitionBootstrap(to: .complete)
        }
    }

    // MARK: - Actor Token Credentials

    /// Schedules proactive credential refresh when the access token is near expiry.
    /// On first launch (no actor token), falls back to bootstrap for initial issuance.
    private func ensureActorCredentials() {
        actorTokenBootstrapTask?.cancel()

        actorTokenBootstrapTask = Task { [weak self] in
            guard let self else { return }

            // If we have no actor token at all, we need initial bootstrap
            if !ActorTokenManager.hasToken {
                await self.performInitialBootstrap()
            }

            // Run proactive refresh loop
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000) // Check every 5 minutes
                guard !Task.isCancelled else { return }

                if ActorTokenManager.needsProactiveRefresh {
                    guard self.daemonClient.isConnected else { continue }

                    let baseURL: String
                    let bearerToken: String?
                    if let httpTransport = self.daemonClient.httpTransport {
                        baseURL = httpTransport.baseURL
                        bearerToken = httpTransport.bearerToken
                    } else if let port = self.daemonClient.httpPort {
                        baseURL = "http://localhost:\(port)"
                        bearerToken = readHttpToken()
                    } else {
                        continue
                    }

                    let result = await ActorCredentialRefresher.refresh(
                        baseURL: baseURL,
                        bearerToken: bearerToken,
                        platform: "macos",
                        deviceId: PairingQRCodeSheet.computeHostId()
                    )

                    switch result {
                    case .success:
                        log.info("Proactive token refresh succeeded")
                    case .terminalError(let reason):
                        log.error("Proactive token refresh failed terminally: \(reason)")
                    case .transientError:
                        log.warning("Proactive token refresh encountered transient error — will retry")
                    }
                }
            }
        }
    }

    /// Performs the initial actor token bootstrap with exponential backoff.
    /// Called only when no actor token exists (first launch or after credential wipe).
    private func performInitialBootstrap() async {
        let deviceId = PairingQRCodeSheet.computeHostId()
        var delay: UInt64 = 2_000_000_000
        let maxDelay: UInt64 = 60_000_000_000
        var connectionDelay: UInt64 = 2_000_000_000
        let connectionMaxDelay: UInt64 = 300_000_000_000

        while !Task.isCancelled {
            guard daemonClient.isConnected else {
                try? await Task.sleep(nanoseconds: connectionDelay)
                connectionDelay = min(connectionDelay * 2, connectionMaxDelay)
                continue
            }

            let success = await daemonClient.bootstrapActorToken(
                platform: "macos",
                deviceId: deviceId
            )

            if success {
                log.info("Initial actor token bootstrap succeeded")
                return
            }

            let jitter = UInt64.random(in: 0...(delay / 4))
            try? await Task.sleep(nanoseconds: delay + jitter)
            delay = min(delay * 2, maxDelay)
        }
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
            managedBootstrapEnabled: isCurrentAssistantManaged,
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

    @objc func performRestart() {
        let bundleURL = Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: bundleURL, configuration: config) { [weak self] _, error in
            if let error {
                log.error("Restart failed — could not launch new instance: \(error.localizedDescription)")
                return
            }
            DispatchQueue.main.async {
                self?.assistantCli.stop()
                NSApp.terminate(nil)
            }
        }
    }

    @objc func performLogout() {
        Task {
            await authManager.logout()

            mainWindow?.close()
            mainWindow = nil
            conversationZoomEnabledCancellable = nil
            conversationBadgeCancellable?.cancel()
            conversationBadgeCancellable = nil
            NSApp.dockTile.badgeLabel = nil
            isConversationZoomEnabled = false

            if let hotKeyMonitor {
                NSEvent.removeMonitor(hotKeyMonitor)
                self.hotKeyMonitor = nil
            }
            self.tearDownQuickInputMonitors()
            quickInputWindow?.dismiss()
            quickInputWindow = nil
            lastRegisteredGlobalHotkey = nil
            lastRegisteredQuickInputHotkey = nil
            globalHotkeyObserver?.cancel()
            globalHotkeyObserver = nil
            if let escapeMonitor {
                NSEvent.removeMonitor(escapeMonitor)
                self.escapeMonitor = nil
            }
            voiceInput?.stop()
            voiceInput = nil
            wakeWordErrorCancellable?.cancel()
            wakeWordErrorCancellable = nil
            wakeWordCoordinator = nil
            ambientAgent.teardown()

            if let observer = windowObserver {
                NotificationCenter.default.removeObserver(observer)
                windowObserver = nil
            }
            statusIconCancellable?.cancel()
            statusIconCancellable = nil
            connectionStatusCancellable?.cancel()
            connectionStatusCancellable = nil
            pulseTimer?.invalidate()
            pulseTimer = nil

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

            actorTokenBootstrapTask?.cancel()
            actorTokenBootstrapTask = nil
            ActorTokenManager.deleteToken()

            assistantCli.stopMonitoring()
            hasSetupApp = false
            hasSetupDaemon = false
            showAuthWindow()
        }
    }

    /// Switches the app to a different lockfile assistant: stops the current
    /// daemon, resets assistant-scoped state, updates persisted state, and
    /// restarts with the new assistant.
    ///
    /// The sequence is intentionally ordered to avoid stale references:
    /// 1. Stop lifecycle monitoring
    /// 2. Clear assistant-scoped runtime state (recording, windows, callbacks)
    /// 3. Stop daemon processes and disconnect transport
    /// 4. Persist the new assistant selection
    /// 5. Reconfigure daemon transport and reconnect
    /// 6. Resume monitoring and credential bootstrap
    func performSwitchAssistant(to assistant: LockfileAssistant) {
        // 1. Stop lifecycle monitoring
        assistantCli.stopMonitoring()

        // 2. Clear assistant-scoped runtime state while the daemon is still
        // running so forceStop can deliver a recording_status IPC message.
        recordingManager.forceStop()
        recordingHUDWindow?.dismiss()

        // 3. Stop daemon processes and disconnect transport
        assistantCli.stop()
        daemonClient.disconnect()
        // Close and recreate the main window to reset thread/session state
        mainWindow?.close()
        mainWindow = nil

        // Cancel any in-progress bootstrap tasks from the previous assistant
        bootstrapRetryTask?.cancel()
        bootstrapRetryTask = nil

        // 4. Persist the new assistant selection
        UserDefaults.standard.set(assistant.assistantId, forKey: "connectedAssistantId")
        assistant.writeToWorkspaceConfig()

        // Clear stale actor token for the previous assistant
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        // 5. Reconfigure daemon transport and reconnect
        hasSetupDaemon = false
        setupDaemonClient()

        // 6. Resume credential bootstrap and show UI
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }
        showMainWindow()
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
                    // Daemon is still running — user can continue using the app.
                    // retire() already set isStopping=true and stopped monitoring;
                    // restart monitoring so the health check remains active.
                    assistantCli.startMonitoring()
                    return false
                }
                // Retire failed but user chose Force Remove — stop the daemon
                // before cleaning up local state.
                daemonClient.disconnect()
                assistantCli.stop()
                self.removeLockfileEntry(assistantId: name)
            }

            // Stop processes after retire succeeds (or user chose Force Remove).
            // This keeps the daemon alive if the user cancels a failed retire.
            daemonClient.disconnect()
            assistantCli.stop()
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
        UserDefaults.standard.removeObject(forKey: "bootstrapState")
        UserDefaults.standard.removeObject(forKey: "connectedAssistantId")
        UserDefaults.standard.removeObject(forKey: "lastActivePanel")

        // Kill the daemon process so ensureDaemonRunning() actually spawns
        // a fresh instance during re-onboarding (equivalent to `vellum sleep`).
        daemonClient.disconnect()
        assistantCli.stop()
        // Cancel any in-progress bootstrap retry so it doesn't race with the
        // new onboarding flow.
        bootstrapRetryTask?.cancel()
        bootstrapRetryTask = nil
        actorTokenBootstrapTask?.cancel()
        actorTokenBootstrapTask = nil
        ActorTokenManager.deleteToken()

        mainWindow?.close()
        mainWindow = nil
        conversationZoomEnabledCancellable = nil
        conversationBadgeCancellable?.cancel()
        conversationBadgeCancellable = nil
        NSApp.dockTile.badgeLabel = nil
        isConversationZoomEnabled = false

        if let hotKeyMonitor {
            NSEvent.removeMonitor(hotKeyMonitor)
            self.hotKeyMonitor = nil
        }
        tearDownQuickInputMonitors()
        quickInputWindow?.dismiss()
        quickInputWindow = nil
        lastRegisteredGlobalHotkey = nil
        globalHotkeyObserver?.cancel()
        globalHotkeyObserver = nil
        if let escapeMonitor {
            NSEvent.removeMonitor(escapeMonitor)
            self.escapeMonitor = nil
        }
        voiceInput?.stop()
        voiceInput = nil
        wakeWordErrorCancellable?.cancel()
        wakeWordErrorCancellable = nil
        wakeWordCoordinator = nil
        ambientAgent.teardown()

        if let observer = windowObserver {
            NotificationCenter.default.removeObserver(observer)
            windowObserver = nil
        }
        statusIconCancellable?.cancel()
        statusIconCancellable = nil
        connectionStatusCancellable?.cancel()
        connectionStatusCancellable = nil
        pulseTimer?.invalidate()
        pulseTimer = nil

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
        daemonClient.disconnect()
        UserDefaults.standard.removeObject(forKey: "user.profile")
        showOnboarding()
        return true
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

    // MARK: - Hotkey

    private var hasSetupHotKey = false

    private func setupHotKey() {
        guard !hasSetupHotKey else { return }
        hasSetupHotKey = true

        registerGlobalHotkeyMonitor()
        registerQuickInputMonitor()
        registerFnVMonitor()
        registerCmdKMonitor()

        globalHotkeyObserver = NotificationCenter.default
            .publisher(for: UserDefaults.didChangeNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.registerGlobalHotkeyMonitor()
                self?.registerQuickInputMonitor()
            }
    }

    /// Registers a Carbon hotkey for Quick Input that intercepts system-wide,
    /// before the frontmost app's menu system can consume it.
    /// Reads the shortcut and key code from UserDefaults. Skips re-registration if unchanged.
    private func registerQuickInputMonitor() {
        let shortcut = UserDefaults.standard.string(forKey: "quickInputHotkeyShortcut") ?? "cmd+shift+/"

        if shortcut == lastRegisteredQuickInputHotkey { return }

        // Tear down previous registration
        if let ref = quickInputHotKeyRef {
            UnregisterEventHotKey(ref)
            quickInputHotKeyRef = nil
        }
        if let ref = quickInputEventHandlerRef {
            RemoveEventHandler(ref)
            quickInputEventHandlerRef = nil
        }

        let storedKeyCode = UserDefaults.standard.object(forKey: "quickInputHotkeyKeyCode") as? Int
        let keyCode = UInt32(storedKeyCode ?? Int(kVK_ANSI_Slash))
        let (modifierFlags, _) = ShortcutHelper.parseShortcut(shortcut)
        let carbonMods = ShortcutHelper.carbonModifiers(from: modifierFlags)

        // Install Carbon event handler for hotkey events
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        var handlerRef: EventHandlerRef?
        InstallEventHandler(GetApplicationEventTarget(), quickInputHotKeyHandler, 1, &eventType, nil, &handlerRef)
        quickInputEventHandlerRef = handlerRef

        let hotKeyID = EventHotKeyID(signature: OSType(0x564C_4D51), id: 1) // "VLMQ"
        var hotKeyRef: EventHotKeyRef?
        let status = RegisterEventHotKey(
            keyCode,
            carbonMods,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        if status == noErr {
            quickInputHotKeyRef = hotKeyRef
            log.info("Quick Input: Carbon hotkey \(ShortcutHelper.displayString(for: shortcut)) registered successfully")
        } else {
            log.error("Quick Input: Failed to register Carbon hotkey, status: \(status)")
        }

        lastRegisteredQuickInputHotkey = shortcut
    }

    /// Removes the Carbon hotkey and event handler registrations.
    private func tearDownQuickInputMonitors() {
        if let ref = quickInputHotKeyRef {
            UnregisterEventHotKey(ref)
            quickInputHotKeyRef = nil
        }
        if let ref = quickInputEventHandlerRef {
            RemoveEventHandler(ref)
            quickInputEventHandlerRef = nil
        }
        if let monitor = fnVGlobalMonitor {
            NSEvent.removeMonitor(monitor)
            fnVGlobalMonitor = nil
        }
        if let monitor = fnVLocalMonitor {
            NSEvent.removeMonitor(monitor)
            fnVLocalMonitor = nil
        }
    }

    /// Registers Cmd+Shift+V as a global shortcut to open the quick input text field.
    /// Uses NSEvent monitors (global + local).
    private func registerFnVMonitor() {
        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            // Cmd+Shift+V: keyCode 9 is kVK_ANSI_V
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard event.keyCode == 9,
                  mods == [.command, .shift] else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.toggleQuickInput(aboveDock: true)
            }
            return nil // consume the event
        }

        fnVGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            _ = handler(event)
        }
        fnVLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers Cmd+K as a local shortcut to open the command palette.
    /// Only active when the app is focused (local monitor, not global).
    private func registerCmdKMonitor() {
        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            // Cmd+K: keyCode 40 is kVK_ANSI_K
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard event.keyCode == 40,
                  mods == [.command] else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.toggleCommandPalette()
            }
            return nil // consume the event
        }
        cmdKLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    func toggleCommandPalette() {
        if let window = commandPaletteWindow, window.isVisible {
            window.dismiss()
            return
        }

        let window = CommandPaletteWindow()

        // Static actions
        window.actions = [
            CommandPaletteAction(id: "new-conversation", icon: "square.and.pencil", label: "New Conversation", shortcutHint: "\u{2318}N") { [weak self] in
                self?.mainWindow?.threadManager.enterDraftMode()
                self?.mainWindow?.windowState.selection = nil
            },
            CommandPaletteAction(id: "settings", icon: "gear", label: "Settings", shortcutHint: "\u{2318},") { [weak self] in
                self?.mainWindow?.windowState.togglePanel(.settings)
            },
            CommandPaletteAction(id: "app-directory", icon: "square.grid.2x2", label: "App Directory", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.showAppsPanel()
            },
            CommandPaletteAction(id: "intelligence", icon: "brain.head.profile", label: "Intelligence", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.togglePanel(.intelligence)
            },
        ]

        // Recent conversations from ThreadManager
        if let threads = mainWindow?.threadManager.threads {
            window.recentItems = threads
                .filter { !$0.isArchived }
                .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                .prefix(5)
                .map { CommandPaletteRecentItem(id: $0.id, title: $0.title, lastInteracted: $0.lastInteractedAt) }
        }

        window.onSelectConversation = { [weak self] threadId in
            self?.mainWindow?.threadManager.selectThread(id: threadId)
        }

        // Wire runtime HTTP resolver for server search
        window.runtimeHTTPResolver = {
            let port = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"]
                .flatMap(Int.init) ?? 7821
            if let jwt = ActorTokenManager.getToken(), !jwt.isEmpty {
                return ("http://localhost:\(port)", jwt)
            }
            guard let token = readHttpToken() else { return nil }
            return ("http://localhost:\(port)", token)
        }

        window.show()
        commandPaletteWindow = window
    }

    func toggleQuickInput(aboveDock: Bool = false, requestScreenPermission: Bool? = nil) {
        if let window = quickInputWindow, window.isVisible {
            window.dismiss()
            return
        }

        // Auto-detect screen recording permission if not explicitly specified
        let shouldShowPermissionPrompt = requestScreenPermission
            ?? (PermissionManager.screenRecordingStatus() != .granted)

        let window = QuickInputWindow()
        window.onSubmit = { [weak self, weak window] message, imageData in
            let notify = window?.notifyOnComplete ?? false
            self?.handleQuickInputSubmit(message, imageData: imageData, notifyOnComplete: notify)
        }
        window.onSubmitToThread = { [weak self, weak window] message, imageData in
            let notify = window?.notifyOnComplete ?? false
            self?.handleQuickInputSubmitToThread(message, imageData: imageData, notifyOnComplete: notify)
        }
        window.onSelectThread = { [weak self] threadId in
            self?.handleQuickInputSelectThread(threadId)
        }
        window.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        // Provide the 3 most recent non-archived threads
        if let threads = mainWindow?.threadManager.threads {
            window.recentThreads = threads
                .filter { !$0.isArchived }
                .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                .prefix(3)
                .map { QuickInputThread(id: $0.id, title: $0.title) }
        }
        window.showScreenPermissionPrompt = shouldShowPermissionPrompt
        if aboveDock {
            window.showAboveDock()
        } else {
            window.show()
        }
        quickInputWindow = window
    }

    /// Starts screen region capture directly from the menu bar icon click.
    /// After the user selects a region, the quick input bar appears near
    /// the selection with the screenshot attached.
    func startScreenCapture() {
        guard PermissionManager.screenRecordingStatus() == .granted else {
            PermissionManager.requestScreenRecordingAccess()
            return
        }

        // Dismiss any existing quick input window
        quickInputWindow?.dismiss()
        quickInputWindow = nil

        let selectionWindow = ScreenSelectionWindow()
        selectionWindow.onComplete = { [weak self] imageData, selectionRect in
            guard let self else { return }

            let window = QuickInputWindow()
            window.onSubmit = { [weak self, weak window] message, imgData in
                let notify = window?.notifyOnComplete ?? false
                self?.handleQuickInputSubmit(message, imageData: imgData, notifyOnComplete: notify)
            }
            window.onSubmitToThread = { [weak self, weak window] message, imgData in
                let notify = window?.notifyOnComplete ?? false
                self?.handleQuickInputSubmitToThread(message, imageData: imgData, notifyOnComplete: notify)
            }
            window.onSelectThread = { [weak self] threadId in
                self?.handleQuickInputSelectThread(threadId)
            }
            window.onMicrophoneToggle = { [weak self] in
                self?.voiceInput?.toggleRecording()
            }
            if let threads = self.mainWindow?.threadManager.threads {
                window.recentThreads = threads
                    .filter { !$0.isArchived }
                    .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                    .prefix(3)
                    .map { QuickInputThread(id: $0.id, title: $0.title) }
            }
            window.setAttachment(imageData: imageData)
            window.showNearRect(selectionRect)
            self.quickInputWindow = window
        }
        selectionWindow.onCancel = { /* User cancelled — do nothing */ }
        selectionWindow.show()
    }

    private func handleQuickInputSubmit(_ message: String, imageData: Data?, notifyOnComplete: Bool) {
        // Ensure mainWindow exists so we can get a ChatViewModel.
        // Never show it — quick input is fire-and-forget.
        ensureMainWindowExists()
        guard let mainWindow else { return }
        mainWindow.threadManager.createThread()
        if let threadId = mainWindow.threadManager.activeThreadId {
            mainWindow.windowState.selection = .thread(threadId)
        }
        guard let viewModel = mainWindow.activeViewModel else { return }

        if notifyOnComplete {
            setupQuickInputNotification(on: viewModel)
        }

        if let imageData {
            viewModel.addAttachment(imageData: imageData, filename: "Screenshot.jpg")
            viewModel.inputText = message
            quickInputAttachmentCancellable = viewModel.attachmentManager.$isLoadingAttachment
                .filter { !$0 }
                .first()
                .sink { [weak self] _ in
                    viewModel.sendMessage()
                    self?.quickInputAttachmentCancellable = nil
                }
        } else {
            viewModel.inputText = message
            viewModel.sendMessage()
        }
    }

    private func handleQuickInputSubmitToThread(_ message: String, imageData: Data?, notifyOnComplete: Bool) {
        guard let mainWindow else { return }
        if let viewModel = mainWindow.activeViewModel {
            if notifyOnComplete {
                setupQuickInputNotification(on: viewModel)
            }
            if let imageData {
                viewModel.addAttachment(imageData: imageData, filename: "Screenshot.jpg")
            }
            viewModel.inputText = message
            viewModel.sendMessage()
        }
    }

    /// Sets a one-shot `onResponseComplete` callback on the view model to send a macOS notification.
    private func setupQuickInputNotification(on viewModel: ChatViewModel) {
        let notificationService = services.activityNotificationService
        viewModel.onResponseComplete = { [weak viewModel] summary in
            // One-shot — clear the callback after firing
            viewModel?.onResponseComplete = nil
            Task {
                await notificationService.notifyQuickInputComplete(summary: summary)
            }
        }
    }

    private func handleQuickInputSelectThread(_ threadId: UUID) {
        showMainWindow()
        guard let mainWindow else { return }
        mainWindow.threadManager.activeThreadId = threadId
    }

    /// Tears down and re-registers the global "Open Vellum" hotkey based on
    /// the current `globalHotkeyShortcut` UserDefaults value. Skips
    /// re-registration if the shortcut hasn't changed.
    private func registerGlobalHotkeyMonitor() {
        let shortcut = UserDefaults.standard.string(forKey: "globalHotkeyShortcut") ?? "cmd+shift+g"

        if shortcut == lastRegisteredGlobalHotkey { return }

        if let existing = hotKeyMonitor {
            NSEvent.removeMonitor(existing)
            hotKeyMonitor = nil
        }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        // Use NSEvent global monitor instead of Carbon RegisterEventHotKey (HotKey package).
        // Carbon hotkeys consume the event globally, preventing other apps from seeing the
        // keystroke. NSEvent.addGlobalMonitorForEvents observes without consuming.
        hotKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let eventMods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard eventMods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else { return }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.showMainWindow()
            }
        }

        lastRegisteredGlobalHotkey = shortcut
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

            // Capture prefix before clearing — it was saved when partials started
            let savedPrefix = (self?.preVoiceInputText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            self?.preVoiceInputText = nil

            // PTT uses priority-based routing because it's a one-shot dictation: the user
            // speaks a single utterance and expects it to go to whatever surface is currently
            // focused. This differs from wake word, which binds to a specific ChatViewModel at
            // activation time for continuous conversational mode (see VoiceModeManager.handleSilenceDetected).
            // Priority 0: Route to quick input bar if visible
            if let quickInput = self?.quickInputWindow, quickInput.isVisible {
                quickInput.setVoiceText(text)
                return
            }

            // Priority 1: Route to main window ChatView if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                // Append transcribed text to any existing input — let the user send manually
                viewModel.inputText = savedPrefix.isEmpty ? text : "\(savedPrefix) \(text)"
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
            // Skip if recording already stopped (late callback from speech recognizer)
            guard self?.voiceInput?.isRecording == true else { return }

            // Priority 0: Route partial text to quick input bar if visible
            if let quickInput = self?.quickInputWindow, quickInput.isVisible {
                quickInput.setVoiceText(text)
                return
            }

            // Priority 1: Route partial text to main window ChatView input if in the foreground
            if NSApp.isActive,
               let mainWindow = self?.mainWindow, mainWindow.isVisible,
               let viewModel = mainWindow.activeViewModel {
                // Capture existing text on first partial so we can prepend it
                if self?.preVoiceInputText == nil {
                    self?.preVoiceInputText = viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                }
                let prefix = self?.preVoiceInputText ?? ""
                viewModel.inputText = prefix.isEmpty ? text : "\(prefix) \(text)"
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
            self.startSession(task: text, source: TaskSubmission.voiceActionSource)
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

            // Sync recording state to the quick input bar
            self?.quickInputWindow?.setRecordingState(isRecording)

            if isRecording {
                self?.statusItem.button?.image = NSImage(
                    systemSymbolName: "mic.fill",
                    accessibilityDescription: "Vellum"
                )
                let quickInputActive = self?.quickInputWindow?.isVisible ?? false
                let isDictation = self?.voiceInput?.currentMode == .dictation
                if !mainWindowActive && !hasActiveConvo && !quickInputActive && !isDictation {
                    let window = VoiceTranscriptionWindow(
                        voiceModeManager: self?.mainWindow?.voiceModeManager
                    )
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

        // Restart key monitors when the activation key is changed remotely via IPC
        NotificationCenter.default.addObserver(
            forName: .activationKeyChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.voiceInput?.restartKeyMonitors()
            }
        }
    }

    // MARK: - Wake Word Coordinator

    private var wakeWordErrorCancellable: AnyCancellable?

    private func setupWakeWordCoordinator() {
        guard let mainWindow else {
            log.warning("Cannot set up wake word coordinator — main window not available")
            return
        }

        let keyword = UserDefaults.standard.string(forKey: "wakeWordKeyword") ?? "computer"
        let engine = SpeechWakeWordEngine(keyword: keyword)
        let audioMonitor = AlwaysOnAudioMonitor(engine: engine)

        let coordinator = WakeWordCoordinator(
            audioMonitor: audioMonitor,
            voiceModeManager: mainWindow.voiceModeManager,
            threadManager: mainWindow.threadManager,
            voiceInputManager: voiceInput
        )

        // Show a toast when the wake word engine hits a persistent error
        // (e.g. Dictation disabled at the OS level).
        wakeWordErrorCancellable = audioMonitor.$persistentErrorMessage
            .compactMap { $0 }
            .sink { [weak self] message in
                self?.mainWindow?.windowState.showToast(
                    message: message,
                    style: .warning,
                    primaryAction: VToastAction(label: "Open Settings") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.keyboard?Dictation") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                )
            }

        if UserDefaults.standard.bool(forKey: "wakeWordEnabled") {
            audioMonitor.startMonitoring()
        }

        coordinator.markReady()
        wakeWordCoordinator = coordinator
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
    private func removeLockfileEntry(assistantId: String) {
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

    private func showOnboarding() {
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

    private func wakeUpGreeting() -> String {
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
