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
    var navLocalMonitor: Any?
    var zoomLocalMonitor: Any?
    public let services = AppServices()
    let assistantCli = AssistantCli()
    public let updateManager = UpdateManager()
    let debugStateWriter = DebugStateWriter()
    private var metricKitManager: MetricKitManager?

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
    var e2eStatusOverlayWindow: E2EStatusOverlayWindow?

    var onboardingWindow: OnboardingWindow?
    var authWindow: NSWindow?
    var authManager: AuthManager { services.authManager }
    public var mainWindow: MainWindow?
    var bundleConfirmationWindow: BundleConfirmationWindow?

    var pairingApprovalWindow: PairingApprovalWindow?
    /// Window shown during first-launch bootstrap when daemon is slow to start.
    var bootstrapInterstitialWindow: NSWindow?
    var crashReportWindow: NSWindow?
    var crashReportWindowObserver: NSObjectProtocol?
    /// Active task for the bootstrap retry coordinator. Cancelled on dismiss.
    var bootstrapRetryTask: Task<Void, Never>?
    /// Tracks the most recent failure kind during bootstrap retries so that
    /// diagnostic messages reflect the actual problem, not generic escalating text.
    var bootstrapFailureKind: BootstrapFailureKind = .unknown
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
    weak var recordingViewModel: ChatViewModel?
    /// Text that was in the chat input before PTT voice recording started,
    /// so we can prepend it to partial/final transcriptions instead of overwriting.
    var preVoiceInputText: String?
    var statusIconCancellable: AnyCancellable?
    var connectionStatusCancellable: AnyCancellable?
    var quickInputAttachmentCancellable: AnyCancellable?
    var conversationBadgeCancellable: AnyCancellable?
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
        metricKitManager = MetricKitManager()

        // Initialize crash reporting eagerly so crashes before the daemon connects
        // are captured. Privacy opt-out is checked after the daemon is ready and
        // applied via SentrySDK.close() — matching the daemon-side pattern in
        // lifecycle.ts (init at top, close after config load if flag disabled).
        let collectUsageData = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
        let perfOptIn = collectUsageData && UserDefaults.standard.bool(forKey: "sendPerformanceReports")
        SentrySDK.start { options in
            options.dsn = "https://c8d6b12505ab6b1785f0e82b5fb50662@o4504590528675840.ingest.us.sentry.io/4511015779696640"
            options.debug = false
            options.tracesSampleRate = 0.1
            // Only profile sampled transactions when user opted into both
            // usage-data collection and performance metrics.
            options.profilesSampleRate = perfOptIn ? 1.0 : 0
            options.sendDefaultPii = false
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
        installCLISymlinkIfNeeded()

        // Ensure actor credentials are present. On first launch this performs
        // initial bootstrap; on subsequent launches it schedules proactive
        // refresh when the access token nears expiry.
        // Skipped in managed mode where actor identity is derived from the
        // platform session, not local actor tokens.
        if !isCurrentAssistantManaged {
            ensureActorCredentials()
        }

        // Provision an AssistantAPIKey for local assistants so they can
        // call platform APIs (e.g. managed avatar generation).
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

}
