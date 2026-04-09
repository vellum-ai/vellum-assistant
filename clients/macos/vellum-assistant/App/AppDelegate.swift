import AppKit
import Carbon
import VellumAssistantShared
import Combine
import CoreText
@preconcurrency import Sentry
import SwiftUI
import UserNotifications
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate")

@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    /// The canonical product / brand name shown in menus, the About panel,
    /// and tooltips.  For CI builds this is either "Vellum" (production) or
    /// "Vellum Staging" (staging).  Local dev builds where
    /// `BUNDLE_DISPLAY_NAME` is a custom assistant name (e.g. "Jarvis") fall
    /// back to "Vellum" so menus and the About panel always show the brand.
    public static let appName: String = {
        let display = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? "Vellum"
        // CI sets BUNDLE_DISPLAY_NAME to "Vellum" or "Vellum Staging".
        // Local dev builds may set it to a custom assistant name.  Only
        // recognise values that start with "Vellum" as valid brand names.
        return display.hasPrefix("Vellum") ? display : "Vellum"
    }()

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
    var isRestarting = false
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
    /// In-flight CU tasks keyed by request ID, for cancel support.
    var inFlightCuTasks: [String: Task<Void, Never>] = [:]
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
    var currentConversationLocalMonitor: Any?
    var newChatMenuItem: NSMenuItem?
    var currentConversationMenuItem: NSMenuItem?
    var fileMenuPatchDelegate: FileMenuPatchDelegate?
    var navLocalMonitor: Any?
    var zoomLocalMonitor: Any?
    var sidebarToggleLocalMonitor: Any?
    var popOutLocalMonitor: Any?
    public let services = AppServices()
    let vellumCli = VellumCli()
    let appleContainersLauncher: AssistantManagementClient? = {
        if #available(macOS 26.0, *) {
            return AppleContainersLauncher()
        }
        return nil
    }()
    public let updateManager = UpdateManager()
    let debugStateWriter = DebugStateWriter()
    private let telemetryClient: any TelemetryClientProtocol = TelemetryClient()
    private var metricKitManager: MetricKitManager?

    // Forwarding accessors — ownership lives in `services`.
    var connectionManager: GatewayConnectionManager { services.connectionManager }
    var eventStreamClient: EventStreamClient { services.connectionManager.eventStreamClient }
    var ambientAgent: AmbientAgent { services.ambientAgent }
    var surfaceManager: SurfaceManager { services.surfaceManager }
    var secretPromptManager: SecretPromptManager { services.secretPromptManager }
    var zoomManager: ZoomManager { services.zoomManager }

    let conversationListClient: any ConversationListClientProtocol = ConversationListClient()
    let computerUseClient: any ComputerUseClientProtocol = ComputerUseClient()
    let appsClient: any AppsClientProtocol = AppsClient()
    let toolConfirmationNotificationService = ToolConfirmationNotificationService()
    /// Shared feature flag store — owned by `AppServices` so `SettingsStore`
    /// can depend on the same instance; forwarded here for backwards
    /// compatibility with existing call sites.
    var featureFlagStore: AssistantFeatureFlagStore { services.featureFlagStore }

    lazy var recordingManager: RecordingManager = RecordingManager(connectionManager: connectionManager)
    var recordingPickerWindow: RecordingSourcePickerWindow?
    var recordingHUDWindow: RecordingHUDWindow?
    var e2eStatusOverlayWindow: E2EStatusOverlayWindow?

    var onboardingWindow: OnboardingWindow?
    var aboutWindow: NSWindow?
    var authWindow: NSWindow?
    public var authManager: AuthManager { services.authManager }
    public var mainWindow: MainWindow?
    var threadWindowManager: ThreadWindowManager?
    var bundleConfirmationWindow: BundleConfirmationWindow?

    var pairingApprovalWindow: PairingApprovalWindow?
    var logReportWindow: NSWindow?
    var logReportWindowObserver: NSObjectProtocol?
    /// Background task that retries actor-token bootstrap until success.
    var actorTokenBootstrapTask: Task<Void, Never>?
    /// Opaque token returned by `NotificationCenter.addObserver(forName:)` for
    /// the assistant-instance-changed observer. Stored so we can properly remove
    /// the closure-based observer before registering a new one.
    var instanceChangeObserver: NSObjectProtocol?
    /// Tracks file paths of .vellum bundles awaiting assistant responses (FIFO).
    /// Each call to sendOpenBundle appends a path; handleOpenBundleResponse
    /// pops the first entry so concurrent opens are correctly paired.
    var pendingBundleFilePaths: [String] = []
    #if DEBUG
    var galleryWindow: ComponentGalleryWindow?
    #endif
    var windowObserver: Any?
    /// Timestamp of the last `showMainWindow` call that performed work.
    /// Used by the debounce guard in `showMainWindow()`.
    var lastShowMainWindowTime: CFAbsoluteTime = 0
    weak var recordingViewModel: ChatViewModel?
    /// Text that was in the chat input before PTT voice recording started,
    /// so we can prepend it to partial/final transcriptions instead of overwriting.
    var preVoiceInputText: String?
    var connectionStatusCancellable: AnyCancellable?
    var quickInputAttachmentCancellable: AnyCancellable?
    var avatarChangeObserver: NSObjectProtocol?
    /// Cached circular avatar image for the menu bar icon. Invalidated only
    /// when `AvatarAppearanceManager.avatarDidChangeNotification` fires, so
    /// connection-status changes, pulse ticks, and thinking-state toggles
    /// reuse the cached image instead of re-resolving the avatar getter chain.
    var cachedMenuBarAvatar: NSImage?
    var pulseTimer: Timer?
    var pulsePhase: CGFloat = 1.0
    var pulseDirection: CGFloat = -1.0
    /// Cached value of the `multi-platform-assistant` flag, read once when
    /// the status item is constructed in `setupMenuBar()`. Flag changes
    /// require relaunch; the status item does not subscribe to live updates
    /// so it stays cheap and predictable.
    var multiAssistantSwitcherEnabled: Bool = false
    /// View model for the menu-bar assistant switcher. Lazily constructed in
    /// `setupMenuBar()` when `multiAssistantSwitcherEnabled` is true.
    var assistantSwitcherViewModel: AssistantSwitcherViewModel?
    var cachedSkills: [SkillInfo] = []
    var refreshSkillsTask: Task<Void, Never>?
    var cachedApps: [AppItem] = []
    var refreshAppsTask: Task<Void, Never>?
    /// The currently-active SSE event subscription task. Stored so it can be
    /// cancelled before creating a new subscription (e.g. on reconnection or
    /// assistant switch), preventing duplicate event processing.
    var eventSubscriptionTask: Task<Void, Never>?
    /// In-flight managed-assistant switch task. Cancelled when a new switch
    /// begins so a stale bootstrap cannot reconnect the wrong assistant.
    var managedSwitchTask: Task<Void, Never>?
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

    /// Whether the current assistant runs remotely (cloud != "local").
    /// When true, local assistant hatching is skipped.
    var isCurrentAssistantRemote = false

    /// Whether the current assistant is platform-managed (cloud == "vellum").
    /// When true, actor credential bootstrap is skipped since identity is
    /// derived from the platform session, not local actor tokens.
    var isCurrentAssistantManaged = false

    /// Whether the current assistant is running in Docker (cloud == "docker").
    /// Docker assistants are classified as remote for transport purposes but
    /// need local credential provisioning like bare-metal local assistants.
    var isCurrentAssistantDocker = false

    /// Set to `true` when `.localBootstrapCompleted` has been posted, so
    /// `awaitLocalBootstrapCompleted` can return immediately if bootstrap
    /// finished before the observer was registered.
    var localBootstrapDidComplete = false

    /// Onboarding state retained during first-launch so post-hatch logic
    /// can access the randomly-generated avatar traits.
    var onboardingState: OnboardingState?

    /// Guards `.appOpen` sound so it fires only once per app session,
    /// even if `proceedToApp()` is called again after assistant switches
    /// or re-authentication flows.
    private var hasPlayedAppOpenSound = false

    @AppStorage("themePreference") private var themePreference: String = "system"

    // MARK: - App Menu Name Patching

    /// The bundle display name from Info.plist (may be a custom dock label).
    private lazy var bundleDisplayName: String = {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? Self.appName
    }()

    /// Delegate that patches the app menu items to "Vellum" right before
    /// macOS renders them.
    private var appMenuPatchDelegate: AppMenuPatchDelegate?
    private var appMenuTrackingObserver: NSObjectProtocol?
    private var appMenuActivationObserver: NSObjectProtocol?

    public func applicationWillFinishLaunching(_ notification: Notification) {
        // Ensure the macOS app menu consistently says "Vellum" (Hide Vellum,
        // Quit Vellum, etc.) regardless of the executable name — which may
        // differ between production builds (renamed to "Vellum" by build.sh)
        // and development builds (SPM target name).  The bundle display name
        // may be a custom dock label (e.g. an assistant name), so we patch
        // both the process name and the main menu items.
        ProcessInfo.processInfo.processName = Self.appName

        FontWarmupCoordinator.shared.start(registerFonts: {
            AppDelegate.registerBundledFonts()
        })
    }

    /// Installs observers that patch the app menu bar title and items to
    /// "Vellum".  The menu bar title is patched via didBeginTracking (fires
    /// when the user clicks the menu bar, before rendering) and the submenu
    /// items are patched via a delegate.
    func patchAppMenuTitles() {
        guard bundleDisplayName != Self.appName else { return }

        if appMenuPatchDelegate == nil {
            appMenuPatchDelegate = AppMenuPatchDelegate(
                bundleDisplayName: bundleDisplayName
            )
        }

        // Patch submenu items via delegate.
        if let appMenu = NSApp.mainMenu?.items.first?.submenu {
            appMenu.delegate = appMenuPatchDelegate
            appMenuPatchDelegate?.patchTitles(menu: appMenu)
        }

        // Capture outside @Sendable closures to avoid main-actor isolation warning.
        let appName = AppDelegate.appName

        // Patch the menu bar title right when the user clicks the menu bar.
        if appMenuTrackingObserver == nil {
            appMenuTrackingObserver = NotificationCenter.default.addObserver(
                forName: NSMenu.didBeginTrackingNotification,
                object: NSApp.mainMenu,
                queue: .main
            ) { _ in
                if let item = NSApp.mainMenu?.items.first, item.title != appName {
                    item.title = appName
                }
            }
        }

        // Patch when the app becomes active (reopen from Dock, Cmd+Tab, etc.)
        // so the title is correct before the user clicks the menu.
        if appMenuActivationObserver == nil {
            appMenuActivationObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { _ in
                if let item = NSApp.mainMenu?.items.first, item.title != appName {
                    item.title = appName
                }
            }
        }

        // Apply immediately, and again after a short delay to catch SwiftUI
        // resetting the title after applicationDidFinishLaunching returns.
        applyMenuBarTitlePatch()
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            self?.applyMenuBarTitlePatch()
        }
    }

    private func applyMenuBarTitlePatch() {
        if let item = NSApp.mainMenu?.items.first, item.title != Self.appName {
            item.title = Self.appName
        }
    }

    /// Install the `FileMenuPatchDelegate` on the SwiftUI-managed File menu.
    /// SwiftUI may not have created the menu yet at launch time, so we retry
    /// with delays (same pattern as Help menu and app-name patching).
    func installFileMenuDelegate() {
        installFileMenuDelegateOnce()
        for delay: UInt64 in [100_000_000, 500_000_000, 1_000_000_000] {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: delay)
                self?.installFileMenuDelegateOnce()
            }
        }
    }

    private func installFileMenuDelegateOnce() {
        guard let mainMenu = NSApp.mainMenu,
              let fileItem = mainMenu.items.first(where: { $0.title == "File" }),
              let fileMenu = fileItem.submenu,
              !(fileMenu.delegate is FileMenuPatchDelegate) else { return }
        let delegate = FileMenuPatchDelegate()
        delegate.appDelegate = self
        self.fileMenuPatchDelegate = delegate
        fileMenu.delegate = delegate
    }

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
        let restartSentinel = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vellum-restart-in-progress")
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
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 300_000_000)
                    NSApp.terminate(nil)
                }
                return
            }
        }

        Self.shared = self

        // Kick off the PTT activator UserDefaults read on a background
        // thread as early as possible so it completes before proceedToApp()
        // sets up voice input monitors.
        PTTActivator.warmCache()

        // Seed the IdentityInfo in-memory cache so that hot paths (menu bar,
        // command palette, session overlay) never block the main thread.
        // The cache is refreshed asynchronously and also on workspace/assistant
        // changes via the LockfileAssistant.activeAssistantDidChange notification.
        Task { @MainActor in await IdentityInfo.warmCache() }

        // Pre-warm the NSSavePanel/NSOpenPanel ViewBridge XPC connection so
        // that user-initiated save/open actions don't block the main thread
        // waiting on _NSViewBridgeMakeSecureConnection (LUM-763).
        SavePanelWarmup.warmUp()

        // Initialize the chat diagnostics store early so launch session
        // metadata and first events exist even if the app wedges during startup.
        _ = ChatDiagnosticsStore.shared

        MainThreadStallDetector.shared.start()
        metricKitManager = MetricKitManager()

        // Prevent macOS from automatically creating window tabs or restoring
        // SwiftUI-managed windows (the Settings scene renders EmptyView and
        // can appear as a blank window during activation policy transitions).
        NSWindow.allowsAutomaticWindowTabbing = false

        // Migrate legacy privacy keys (collectUsageDataEnabled,
        // sendPerformanceReports) to their canonical equivalents
        // synchronously so the Sentry gate below sees the correct value.
        Self.migratePrivacyDefaults()

        // Migrate legacy connectedAssistantId from UserDefaults to the
        // lockfile's activeAssistant field. Must run before any
        // loadAssistantFromLockfile() calls.
        Self.migrateConnectedAssistantIdToLockfile()

        // Gated on sendDiagnostics: if the user has previously disabled diagnostics,
        // Sentry is never initialized. Otherwise, initialize eagerly so crashes
        // before the daemon connects are captured.
        let sendDiagnostics = UserDefaults.standard.object(forKey: "sendDiagnostics") as? Bool
            ?? UserDefaults.standard.object(forKey: "collectUsageData") as? Bool
            ?? true

        // Collect pending IPS crash logs BEFORE starting Sentry so they
        // can be attached to the scope for the automatic crash event.
        let crashLogURLs = sendDiagnostics ? CrashReporter.pendingCrashLogURLs() : []

        if sendDiagnostics && !MetricKitManager.macosDSN.isEmpty {
            let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
            let buildNumber = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
            let commitSHA = Bundle.main.infoDictionary?["VellumCommitSHA"] as? String
            nonisolated(unsafe) var crashedLastRun = false
            SentrySDK.start { options in
                options.dsn = MetricKitManager.macosDSN
                options.releaseName = "vellum-macos@\(appVersion)"
                options.dist = commitSHA ?? buildNumber
                options.environment = SentryDeviceInfo.sentryEnvironment
                options.debug = false
                options.tracesSampleRate = 0.1
                options.configureProfiling = { profilingOptions in
                    profilingOptions.sessionSampleRate = 1.0
                }
                options.sendDefaultPii = false
                options.maxAttachmentSize = MetricKitManager.sentryMaxAttachmentSize

                if !crashLogURLs.isEmpty {
                    options.onCrashedLastRun = { _ in crashedLastRun = true }
                }

                // Configure initialScope so telemetry tags AND IPS crash
                // log attachments are present BEFORE the SDK flushes stored
                // crash events. The crash event envelope is built during
                // start(), so these ride along with the fatal event itself.
                options.initialScope = { scope in
                    SentryDeviceInfo.applyTags(to: scope)
                    for url in crashLogURLs {
                        scope.addAttachment(
                            Attachment(path: url.path, filename: url.lastPathComponent)
                        )
                    }
                    return scope
                }
            }
            // Also configure the live scope for events after start().
            SentryDeviceInfo.configureSentryScope()

            // The crash event's envelope was built during start() and
            // already includes the IPS scope attachments. Clear them
            // synchronously so no subsequent events carry the files.
            if !crashLogURLs.isEmpty {
                SentrySDK.configureScope { scope in
                    scope.clearAttachments()
                }
                if crashedLastRun {
                    CrashReporter.markAsSeen(crashLogURLs)
                }
            }

            SentryLogReporter.start()
        }

        // Record this launch so the next session can identify new crashes.
        CrashReporter.recordLaunch()

        // Remove stale SwiftUI Settings window frame to prevent a ghost
        // window from being restored on launch (the Settings scene now
        // renders EmptyView — we handle settings in the main window panel).
        UserDefaults.standard.removeObject(forKey: "NSWindow Frame com_apple_SwiftUI_Settings_window")

        // Remove orphaned conversation zoom key. ConversationZoomManager was
        // deleted (redundant with window-level ZoomManager); clean up any
        // persisted value so it doesn't linger in UserDefaults.
        UserDefaults.standard.removeObject(forKey: "conversationTextZoomLevel")

        // Migrate API keys from plaintext UserDefaults to credential storage
        // (file-based credential storage). Safe to call on every
        // launch — skips providers already present in credential storage.
        APIKeyManager.migrateFromUserDefaults()

        if let envPath = MacOSClientFeatureFlagManager.findRepoEnvFile() {
            MacOSClientFeatureFlagManager.shared.loadFromFile(at: envPath)
        }

        applyThemePreference()
        AvatarAppearanceManager.shared.start()

        #if DEBUG
        let skipOnboarding = CommandLine.arguments.contains("--skip-onboarding")
        #else
        let skipOnboarding = false
        #endif

        if let statusFile = ProcessInfo.processInfo.environment["E2E_STATUS_FILE"] {
            Task { @MainActor in
                await FontWarmupCoordinator.shared.awaitReady()
                let overlay = E2EStatusOverlayWindow(statusFilePath: statusFile)
                overlay.show()
                self.e2eStatusOverlayWindow = overlay
            }
        }

        // Set up menu bar and hotkeys early so they work regardless of auth state.
        setupMenuBar()
        patchAppMenuTitles()
        installFileMenuDelegate()
        setupHotKey()

        // Install CLI symlinks in the background. installSymlink() spawns
        // /usr/bin/which via Process.waitUntilExit() which internally blocks
        // on a DispatchSemaphore — running it on the main thread causes a
        // ~2s app hang (LUM-630). The symlinks are best-effort and don't
        // need to complete before the daemon starts.
        let isDevMode = DevModeManager.shared.isDevMode
        Task.detached(priority: .utility) {
            Self.installCLISymlinkIfNeeded(isDevMode: isDevMode)
        }

        // Install the Chrome native messaging host manifest so the
        // Vellum Chrome extension can spawn the bundled helper binary
        // via `chrome.runtime.connectNative("com.vellum.daemon")`.
        // Best-effort and idempotent — see
        // `AppDelegate+NativeMessaging.swift` for details. Runs off
        // the main thread because it touches `~/Library` on disk.
        Task.detached(priority: .utility) {
            Self.installChromeNativeMessagingHostIfNeeded()
        }

        let hasAssistants = lockfileHasAssistants()
        log.info("[appLaunch] skipOnboarding=\(skipOnboarding) hasAssistants=\(hasAssistants)")

        if !skipOnboarding && !hasAssistants {
            log.info("[appLaunch] → showOnboarding() (awaiting font warmup)")
            Task { @MainActor in
                await FontWarmupCoordinator.shared.awaitReady()
                self.showOnboarding()
            }
            return
        }

        log.info("[appLaunch] → startAuthenticatedFlow() (awaiting font warmup)")
        Task { @MainActor in
            await FontWarmupCoordinator.shared.awaitReady()
            self.startAuthenticatedFlow()
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
            // Check for a pending managed assistant switch (set by performSwitchAssistant
            // when the user was logged out). Now that the user has re-authenticated and
            // the app is already set up, complete the switch.
            if let pendingId = UserDefaults.standard.string(forKey: "pendingManagedSwitchAssistantId"),
               !pendingId.isEmpty {
                UserDefaults.standard.removeObject(forKey: "pendingManagedSwitchAssistantId")
                if let assistant = LockfileAssistant.loadByName(pendingId) {
                    performSwitchAssistant(to: assistant)
                    return
                }
            }
            showMainWindow()
            return
        }
        hasSetupApp = true

        // On first launch (post-onboarding), the lockfile now has the
        // hatched assistant. Reset hasSetupDaemon so setupGatewayConnectionManager()
        // re-reads the lockfile, configures the correct transport (HTTP
        // for remote), and wires all callbacks to the right GatewayConnectionManager.
        if isFirstLaunch {
            hasSetupDaemon = false
        }

        if threadWindowManager == nil {
            threadWindowManager = ThreadWindowManager(services: services)
        }
        setupGatewayConnectionManager()
        setupMenuBar()
        setupFileMenu()
        patchAppMenuTitles()
        registerNavigationMonitor()
        registerZoomMonitor()
        registerSidebarToggleMonitor()
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

        SoundManager.shared.start(featureFlagStore: featureFlagStore)
        RandomSoundTimer.shared.start()
        if !hasPlayedAppOpenSound {
            hasPlayedAppOpenSound = true
            SoundManager.shared.play(.appOpen)
        }

        // On cold-start reauth (non-first-launch), check for a pending managed
        // assistant switch BEFORE bootstrapping credentials. This avoids
        // provisioning against the wrong assistant only to immediately switch.
        if !isFirstLaunch,
           let pendingId = UserDefaults.standard.string(forKey: "pendingManagedSwitchAssistantId"),
           !pendingId.isEmpty {
            UserDefaults.standard.removeObject(forKey: "pendingManagedSwitchAssistantId")
            if let assistant = LockfileAssistant.loadByName(pendingId) {
                performSwitchAssistant(to: assistant)
                return
            }
        }

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
            // pendingDaemon → pendingWakeupSend → pendingFirstReply → complete.
            // Each transition is persisted so a restart resumes correctly.
            bootstrapStartTime = CFAbsoluteTimeGetCurrent()
            transitionBootstrap(to: .pendingDaemon)
            Task {
                let ready = await awaitDaemonReady(timeout: 15)

                if ready {
                    // Gateway is healthy — reload the avatar now so it
                    // reflects the user's saved image instead of the
                    // bundled Vellum logo.
                    // Skip the reload when onboarding avatar traits are pending —
                    // the async fetchTraitsViaHTTP inside reloadAvatar would find
                    // no traits on the freshly-hatched assistant and clear the
                    // locally-saved character avatar.
                    if self.onboardingState?.hatchAvatarBodyShape != nil {
                        log.info("[avatarSync] first-launch: skipping reloadAvatar, syncing onboarding traits instead")
                        self.syncOnboardingAvatarIfNeeded()
                    } else {
                        AvatarAppearanceManager.shared.reloadAvatar()
                    }

                    // Record lifecycle telemetry events (fire-and-forget).
                    Task { await self.telemetryClient.recordLifecycleEvent("hatch") }
                    Task { await self.telemetryClient.recordLifecycleEvent("app_open") }

                    // If the user is signed in with a local assistant, wait for
                    // credential provisioning to complete before sending the wake-up
                    // greeting, so the managed-proxy key is available for the LLM call.
                    if authManager.isAuthenticated && (!isCurrentAssistantRemote || isCurrentAssistantDocker) {
                        await awaitLocalBootstrapCompleted(timeout: 30)
                    }

                    // Push locally-stored LLM provider keys (e.g. Anthropic) to the
                    // assistant so it can fulfil the first message. Without this the
                    // wake-up greeting races with the detached key sync from onboarding
                    // and may hit "No providers available".
                    await self.syncApiKeysViaGateway()

                    // Assistant connected within timeout — proceed directly
                    // to mandatory wake-up send with retries.
                    transitionBootstrap(to: .pendingWakeupSend)
                    await performRetriableWakeUpSend()
                } else {
                    // Assistant not ready — show the main window with a
                    // timeout screen so the user knows something went wrong.
                    log.warning("Assistant not ready after timeout — showing timeout screen")
                    // Can't sync traits (no daemon), but still clean up onboarding state.
                    self.onboardingState = nil
                    transitionBootstrap(to: .timedOut)
                    showMainWindow(isFirstLaunch: true)
                    debugStateWriter.start(appDelegate: self)
                }
            }
        } else {
            // Record app_open telemetry event (fire-and-forget).
            // The assistant may not be connected yet, so retry briefly.
            Task {
                let ready = await awaitDaemonReady(timeout: 10)
                if ready {
                    // Gateway is healthy — reload the avatar so
                    // logout→re-login cycles repopulate the dock icon.
                    if self.onboardingState?.hatchAvatarBodyShape != nil {
                        log.info("[avatarSync] non-first-launch: skipping reloadAvatar, syncing onboarding traits instead")
                        self.syncOnboardingAvatarIfNeeded()
                    } else {
                        AvatarAppearanceManager.shared.reloadAvatar()
                    }
                    await self.telemetryClient.recordLifecycleEvent("app_open")
                } else {
                    // Can't sync traits (no daemon), but still clean up onboarding state.
                    self.onboardingState = nil
                }
            }

            showMainWindow()
            debugStateWriter.start(appDelegate: self)
        }
    }

    // MARK: - Application Lifecycle

    /// Defers termination so `cli.stop()` can run asynchronously without
    /// blocking the main thread.  macOS calls this before
    /// `applicationWillTerminate`; returning `.terminateLater` keeps the
    /// run loop alive until `reply(toApplicationShouldTerminate:)` is
    /// called.
    ///
    /// The reply is dispatched via `DispatchQueue.main.async` rather than
    /// `MainActor.run` because the Swift concurrency MainActor executor
    /// is not reliably serviced during AppKit's `.terminateLater` shutdown
    /// phase, which can deadlock the quit sequence (LUM-764).
    ///
    /// Reference: https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldterminate(_:)
    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // During a restart, performRestart() already stopped the CLI and
        // disconnected the connection manager.  Skip the async
        // .terminateLater path whose MainActor.run dispatch is fragile
        // during AppKit shutdown and can leave the process as a zombie.
        if isRestarting {
            return .terminateNow
        }

        let cli = vellumCli
        Task.detached {
            await cli.stop()
            DispatchQueue.main.async {
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    public func applicationWillTerminate(_ notification: Notification) {
        // If Sparkle has a deferred update ready, install it now during
        // the quit sequence so the new version launches after termination.
        updateManager.installDeferredUpdateIfAvailable()

        // Restore the Vellum logo so the pinned dock tile caches the
        // correct icon instead of whatever avatar was showing at quit time.
        AvatarAppearanceManager.shared.restoreBundleIcon()

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
        if let observer = appMenuTrackingObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = appMenuActivationObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        NSApp.dockTile.badgeLabel = nil
        connectionStatusCancellable?.cancel()
        pulseTimer?.invalidate()
        pulseTimer = nil
        threadWindowManager?.closeAll()
        voiceInput?.prepareForTermination()
        voiceInput?.stop()
        ambientAgent.teardown()
        surfaceManager.dismissAll()
        toolConfirmationNotificationService.dismissAll()
        secretPromptManager.dismissAll()
        recordingManager.forceStop()
        recordingHUDWindow?.dismiss()
        e2eStatusOverlayWindow?.dismiss()
        eventSubscriptionTask?.cancel()
        debugStateWriter.stop()
        RandomSoundTimer.shared.stop()
    }

    // MARK: - Public Actions (for SwiftUI .commands menu items)

    public func performZoomIn() { zoomManager.zoomIn() }
    public func performZoomOut() { zoomManager.zoomOut() }
    public func performZoomReset() { zoomManager.resetZoom() }

    public func popOutActiveConversation() {
        guard let mainWindow = mainWindow,
              let id = mainWindow.conversationManager.activeConversationId,
              mainWindow.conversationManager.activeConversation?.conversationId != nil else { return }
        threadWindowManager?.openThread(
            conversationLocalId: id,
            conversationManager: mainWindow.conversationManager
        )
    }

    public func createNewConversation() {
        showMainWindow()
        mainWindow?.conversationManager.createConversation()
        SoundManager.shared.play(.newConversation)
    }

    /// If onboarding generated avatar traits, sync them to the assistant and clear the state.
    /// Called from both the first-launch and non-first-launch paths in `proceedToApp`
    /// so that auth-gate onboarding flows also persist avatar traits on the assistant.
    func syncOnboardingAvatarIfNeeded() {
        guard let body = onboardingState?.hatchAvatarBodyShape,
              let eyes = onboardingState?.hatchAvatarEyeStyle,
              let color = onboardingState?.hatchAvatarColor else {
            onboardingState = nil
            return
        }
        log.info("[avatarSync] syncOnboardingAvatarIfNeeded: traits=\(body.rawValue)/\(eyes.rawValue)/\(color.rawValue)")
        // Eagerly apply onboarding avatar traits so the ComingAliveOverlay
        // (and any other UI) can render the character avatar immediately
        // instead of falling back to the bundled green V logo while the
        // async assistant sync completes.
        if AvatarAppearanceManager.shared.customAvatarImage == nil,
           AvatarAppearanceManager.shared.characterBodyShape == nil {
            let image = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color)
            AvatarAppearanceManager.shared.saveAvatar(image, bodyShape: body, eyeStyle: eyes, color: color)
            log.info("[avatarSync] saved avatar locally")
        } else {
            log.info("[avatarSync] skipping local save — customAvatarImage=\(AvatarAppearanceManager.shared.customAvatarImage != nil) characterBodyShape=\(AvatarAppearanceManager.shared.characterBodyShape?.rawValue ?? "nil")")
        }
        Task {
            await AvatarAppearanceManager.shared.syncTraitsToDaemon(
                bodyShape: body, eyeStyle: eyes, color: color
            )
        }
        onboardingState = nil
    }

}
