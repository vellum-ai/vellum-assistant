import AppKit
import Carbon
import VellumAssistantShared
import Combine
import CoreText
@preconcurrency import Sentry
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
    var currentSession: (any SessionOverlayProviding)?
    /// Proxy state tracker for host CU overlay (proxy-based computer use sessions).
    var activeHostCuProxy: HostCuSessionProxy?
    /// Conversation/session ID of the active host CU overlay.
    var activeOverlayConversationId: String?
    /// Cleanup task for dismissing the host CU overlay after completion.
    var hostCuOverlayCleanupTask: Task<Void, Never>?
    /// Combine subscriptions for host CU overlay state observation.
    var hostCuOverlayCancellables = Set<AnyCancellable>()
    var isStartingSession = false
    var startSessionTask: Task<Void, Never>?
    var voiceInput: VoiceInputManager?
    var voiceTranscriptionWindow: VoiceTranscriptionWindow?
    var quickInputWindow: QuickInputWindow?
    var quickInputHotKeyRef: EventHotKeyRef?
    var quickInputEventHandlerRef: EventHandlerRef?
    var commandPaletteWindow: CommandPaletteWindow?
    var cmdKLocalMonitor: Any?
    var cmdNLocalMonitor: Any?
    var navLocalMonitor: Any?
    var zoomLocalMonitor: Any?
    public let services = AppServices()
    let assistantCli = AssistantCli()
    public let updateManager = UpdateManager()
    let debugStateWriter = DebugStateWriter()
    private let telemetryClient: any TelemetryClientProtocol = TelemetryClient()
    private var metricKitManager: MetricKitManager?

    // Forwarding accessors — ownership lives in `services`, these keep
    // existing internal references working without a mass-rename.
    var daemonClient: DaemonClient { services.daemonClient }
    var ambientAgent: AmbientAgent { services.ambientAgent }
    var surfaceManager: SurfaceManager { services.surfaceManager }
    var secretPromptManager: SecretPromptManager { services.secretPromptManager }
    var zoomManager: ZoomManager { services.zoomManager }

    let toolConfirmationNotificationService = ToolConfirmationNotificationService()
    lazy var recordingManager: RecordingManager = RecordingManager(daemonClient: daemonClient)
    var recordingPickerWindow: RecordingSourcePickerWindow?
    var recordingHUDWindow: RecordingHUDWindow?
    var e2eStatusOverlayWindow: E2EStatusOverlayWindow?

    var onboardingWindow: OnboardingWindow?
    var authWindow: NSWindow?
    public var authManager: AuthManager { services.authManager }
    public var mainWindow: MainWindow?
    var bundleConfirmationWindow: BundleConfirmationWindow?

    var pairingApprovalWindow: PairingApprovalWindow?
    var crashReportWindow: NSWindow?
    var crashReportWindowObserver: NSObjectProtocol?
    var logReportWindow: NSWindow?
    var logReportWindowObserver: NSObjectProtocol?
    /// Background task that retries actor-token bootstrap until success.
    var actorTokenBootstrapTask: Task<Void, Never>?
    /// Opaque token returned by `NotificationCenter.addObserver(forName:)` for
    /// the daemon-instance-changed observer. Stored so we can properly remove
    /// the closure-based observer before registering a new one.
    var instanceChangeObserver: NSObjectProtocol?
    /// Tracks file paths of .vellum bundles awaiting daemon responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    var pendingBundleFilePaths: [String] = []
    #if DEBUG
    var galleryWindow: ComponentGalleryWindow?
    #endif
    #if !DEBUG
    var keychainBroker: KeychainBrokerServer?
    #endif
    var windowObserver: Any?
    /// Timestamp of the last `showMainWindow` call that performed work.
    /// Used by the debounce guard in `showMainWindow()`.
    var lastShowMainWindowTime: CFAbsoluteTime = 0
    weak var recordingViewModel: ChatViewModel?
    /// Text that was in the chat input before PTT voice recording started,
    /// so we can prepend it to partial/final transcriptions instead of overwriting.
    var preVoiceInputText: String?
    var statusIconCancellable: AnyCancellable?
    var connectionStatusCancellable: AnyCancellable?
    var quickInputAttachmentCancellable: AnyCancellable?
    var conversationBadgeCancellable: AnyCancellable?
    var avatarChangeObserver: NSObjectProtocol?
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
    /// multiple notification conversations are created in quick succession.
    var hasRequestedNotificationAuthorizationFromConversationSignal = false
    /// Last time we surfaced the denied-notification permission toast.
    var lastNotificationPermissionToastAtMs: Double = 0

    /// Structured error from the most recent daemon startup failure.
    /// Populated by `setupDaemonClient()` when `hatch()` throws a
    /// `CLIError.daemonStartupFailed`. Read by the UI (PR 3) to show a
    /// contextual error view instead of a generic failure message.
    @Published var daemonStartupError: DaemonStartupError?

    /// Whether the current assistant runs remotely (cloud != "local").
    /// When true, local daemon hatching is skipped.
    var isCurrentAssistantRemote = false

    /// Whether the current assistant is platform-managed (cloud == "vellum").
    /// When true, actor credential bootstrap is skipped since identity is
    /// derived from the platform session, not local actor tokens.
    var isCurrentAssistantManaged = false

    /// Set to `true` when `.localBootstrapCompleted` has been posted, so
    /// `awaitLocalBootstrapCompleted` can return immediately if bootstrap
    /// finished before the observer was registered.
    var localBootstrapDidComplete = false

    @AppStorage("themePreference") private var themePreference: String = "system"

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // ── Single-instance guard ──────────────────────────────────────
        // If another copy of this app is already running (e.g. Sparkle
        // relaunch race, macOS state restoration, or accidental double-
        // open), activate the existing instance and terminate this one.
        // Uses Apple's NSRunningApplication API — the recommended way to
        // detect running instances on macOS.
        //
        // Exception: performRestart() launches a new instance via
        // NSWorkspace.openApplication (createsNewApplicationInstance: true)
        // before terminating the old one.  Both processes are briefly
        // alive.  performRestart() writes a transient sentinel file that
        // the new instance checks here; if the file exists we are the
        // replacement process and should proceed normally.
        let restartSentinel = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".vellum/restart-in-progress")
        let isRestart: Bool = {
            guard let data = try? Data(contentsOf: restartSentinel),
                  let stamp = String(data: data, encoding: .utf8),
                  let written = TimeInterval(stamp) else {
                // No file or unreadable — not a restart.
                return false
            }
            // Honor the sentinel only if it was written within the last
            // 30 seconds.  Stale sentinels (e.g. from a crash between
            // writing and the new instance reading it) are ignored so
            // the single-instance guard stays effective.
            return Date().timeIntervalSince1970 - written < 30
        }()
        // Always remove the sentinel regardless of freshness so it
        // doesn't accumulate on disk.
        try? FileManager.default.removeItem(at: restartSentinel)

        if !isRestart, let bundleId = Bundle.main.bundleIdentifier {
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
                .filter { $0 != .current && !$0.isTerminated }
            if let existing = others.first {
                log.info("[singleInstance] Another instance (pid \(existing.processIdentifier)) detected — activating it and terminating self")
                existing.activate()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    NSApp.terminate(nil)
                }
                return
            }
        }

        Self.shared = self
        MainThreadStallDetector.shared.start()
        metricKitManager = MetricKitManager()

        // Prevent macOS from automatically creating window tabs or restoring
        // SwiftUI-managed windows (the Settings scene renders EmptyView and
        // can appear as a blank window during activation policy transitions).
        NSWindow.allowsAutomaticWindowTabbing = false

        // Gated on sendDiagnostics: if the user has previously disabled diagnostics,
        // Sentry is never initialized. Otherwise, initialize eagerly so crashes
        // before the daemon connects are captured.
        let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
            ?? UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
            ?? true
        if sendDiagnostics {
            let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
            let buildNumber = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
            SentrySDK.start { options in
                options.dsn = MetricKitManager.macosDSN
                options.releaseName = "vellum-macos@\(appVersion)"
                options.dist = buildNumber
                options.environment = SentryDeviceInfo.sentryEnvironment
                options.debug = false
                options.tracesSampleRate = 0.1
                options.configureProfiling = { profilingOptions in
                    profilingOptions.sessionSampleRate = 1.0
                }
                options.sendDefaultPii = false
                options.maxAttachmentSize = MetricKitManager.sentryMaxAttachmentSize
            }
            SentryDeviceInfo.configureSentryScope()
        }

        // Surface any crash log from the previous session so the user can send
        // it. Also records this launch timestamp for the next session's check.
        checkForPreviousCrash()

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

        // Migrate API keys from plaintext UserDefaults to credential storage
        // (Keychain in Release, file-based in DEBUG). Safe to call on every
        // launch — skips providers already present in credential storage.
        APIKeyManager.migrateFromUserDefaults()

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

        if let statusFile = ProcessInfo.processInfo.environment["E2E_STATUS_FILE"] {
            let overlay = E2EStatusOverlayWindow(statusFilePath: statusFile)
            overlay.show()
            self.e2eStatusOverlayWindow = overlay
        }

        // Set up menu bar and hotkeys early so they work regardless of auth state.
        setupMenuBar()
        setupHotKey()

        // Install CLI symlinks early so they are available before the daemon
        // starts, regardless of auth or onboarding state.
        installCLISymlinkIfNeeded()

        let hasAssistants = lockfileHasAssistants()
        log.info("[appLaunch] skipOnboarding=\(skipOnboarding) hasAssistants=\(hasAssistants)")

        if !skipOnboarding && !hasAssistants {
            log.info("[appLaunch] → showOnboarding()")
            showOnboarding()
            return
        }

        log.info("[appLaunch] → startAuthenticatedFlow()")
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
        // Reload avatar after reconnecting so that logout→re-login cycles
        // repopulate the dock icon (resetForDisconnect clears it on logout).
        AvatarAppearanceManager.shared.reloadAvatar()
        setupMenuBar()
        setupFileMenu()
        registerNavigationMonitor()
        registerZoomMonitor()
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

        // Ensure actor credentials are present. On first launch this performs
        // initial bootstrap; on subsequent launches it schedules proactive
        // refresh when the access token nears expiry.
        // Skipped in managed mode where actor identity is derived from the
        // platform session, not local actor tokens.
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }

        // Reset before provisioning so a stale flag from a previous
        // bootstrap cycle doesn't cause awaitLocalBootstrapCompleted to
        // skip the wait for the new cycle's credentials.
        localBootstrapDidComplete = false

        // Provision an AssistantAPIKey for local assistants so they can
        // call platform APIs.
        ensureLocalAssistantApiKey()

        if isFirstLaunch {
            // Enter the bootstrap state machine. The sequence is:
            // pendingDaemon → pendingWakeupSend → pendingFirstReply → complete
            // Each transition is persisted so a restart resumes correctly.
            bootstrapStartTime = CFAbsoluteTimeGetCurrent()
            transitionBootstrap(to: .pendingDaemon)
            Task {
                let ready = await awaitDaemonReady(timeout: 15)

                if ready {
                    // Record lifecycle telemetry events (fire-and-forget).
                    Task { await self.telemetryClient.recordLifecycleEvent("hatch") }
                    Task { await self.telemetryClient.recordLifecycleEvent("app_open") }

                    // If the user is signed in with a local assistant, wait for
                    // credential provisioning to complete before sending the wake-up
                    // greeting, so the managed-proxy key is available for the LLM call.
                    if authManager.isAuthenticated && !isCurrentAssistantRemote {
                        await awaitLocalBootstrapCompleted(timeout: 30)
                    }

                    // Push locally-stored LLM provider keys (e.g. Anthropic) to the
                    // daemon so it can fulfil the first message. Without this the
                    // wake-up greeting races with the detached key sync from onboarding
                    // and may hit "No providers available".
                    await self.syncApiKeysViaGateway()

                    // Daemon connected within timeout — proceed directly
                    // to mandatory wake-up send with retries.
                    transitionBootstrap(to: .pendingWakeupSend)
                    await performRetriableWakeUpSend()
                } else {
                    // Daemon not ready — show the main window with a
                    // timeout screen so the user knows something went wrong.
                    log.warning("Daemon not ready after timeout — showing timeout screen")
                    transitionBootstrap(to: .timedOut)
                    showMainWindow(isFirstLaunch: true)
                    debugStateWriter.start(appDelegate: self)
                }
            }
        } else {
            // Record app_open telemetry event (fire-and-forget).
            // The daemon may not be connected yet, so retry briefly.
            Task {
                let ready = await awaitDaemonReady(timeout: 10)
                if ready {
                    await self.telemetryClient.recordLifecycleEvent("app_open")
                }
            }
            showMainWindow()
            debugStateWriter.start(appDelegate: self)
        }
    }

    // MARK: - Application Lifecycle

    public func applicationWillTerminate(_ notification: Notification) {
        // If Sparkle has a deferred update ready, install it now during
        // the quit sequence so the new version launches after termination.
        updateManager.installDeferredUpdateIfAvailable()

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
        if let observer = avatarChangeObserver {
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
        e2eStatusOverlayWindow?.dismiss()
        debugStateWriter.stop()
        #if !DEBUG
        keychainBroker?.stop()
        #endif
        assistantCli.stop()
    }

    // MARK: - Public Actions (for SwiftUI .commands menu items)

    public func performZoomIn() { zoomManager.zoomIn() }
    public func performZoomOut() { zoomManager.zoomOut() }
    public func performZoomReset() { zoomManager.resetZoom() }

    public func createNewConversation() {
        showMainWindow()
        mainWindow?.conversationManager.createConversation()
    }

}
