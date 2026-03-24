import SwiftUI
import VellumAssistantShared

enum SettingsTab: String {
    case general = "General"
    case modelsAndServices = "Models & Services"
    case voice = "Voice"
    case sounds = "Sounds"
    case permissionsAndPrivacy = "Permissions & Privacy"
    case billing = "Billing"
    case archivedConversations = "Archived Conversations"
    case schedules = "Schedules"
    case developer = "Developer"

    /// Primary tabs shown in the main nav list (excludes feature-flagged bottom tabs).
    static func primaryTabs(billingEnabled: Bool = false, soundsEnabled: Bool = true, schedulesEnabled: Bool = false) -> [SettingsTab] {
        var tabs: [SettingsTab] = [.general, .modelsAndServices, .voice]
        if soundsEnabled { tabs.append(.sounds) }
        if billingEnabled { tabs.append(.billing) }
        tabs.append(.permissionsAndPrivacy)
        tabs.append(.archivedConversations)
        if schedulesEnabled { tabs.append(.schedules) }
        return tabs
    }
}

@MainActor
struct SettingsPanel: View {
    var onClose: () -> Void
    @ObservedObject var store: SettingsStore
    var connectionManager: GatewayConnectionManager?
    @ObservedObject var conversationManager: ConversationManager
    var authManager: AuthManager
    @ObservedObject var assistantFeatureFlagStore: AssistantFeatureFlagStore
    var showToast: (String, ToastInfo.Style) -> Void
    var featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()

    // MARK: - Init

    init(
        onClose: @escaping () -> Void,
        store: SettingsStore,
        connectionManager: GatewayConnectionManager? = nil,
        conversationManager: ConversationManager,
        authManager: AuthManager,
        assistantFeatureFlagStore: AssistantFeatureFlagStore,
        showToast: @escaping (String, ToastInfo.Style) -> Void,
        featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()
    ) {
        self.onClose = onClose
        self._store = ObservedObject(wrappedValue: store)
        self.connectionManager = connectionManager
        self._conversationManager = ObservedObject(wrappedValue: conversationManager)
        self.authManager = authManager
        self._assistantFeatureFlagStore = ObservedObject(wrappedValue: assistantFeatureFlagStore)
        self.showToast = showToast
        self.featureFlagClient = featureFlagClient

        // Pre-compute the billing flag so the first render already has the
        // correct tab list in the sidebar nav.
        let billingEnabled = MacOSClientFeatureFlagManager.shared.isEnabled(Self.billingFeatureFlagKey)
        _isBillingEnabled = State(initialValue: billingEnabled)

        // Pre-compute the sounds flag so deep-link validation below uses
        // the actual config value instead of the @State default (true).
        let soundsEnabled = assistantFeatureFlagStore.isEnabled(Self.soundsFeatureFlagKey)
        _isSoundsEnabled = State(initialValue: soundsEnabled)

        // Derive the initial tab from the pending deep-link at construction
        // time. Previous attempts set selectedTab in onAppear / onChange, but
        // those fire *after* the first render and are susceptible to timing
        // races (e.g. the view being recreated when isAppChatOpen toggles in
        // the selection didSet, which consumes pendingSettingsTab on the
        // first instance and leaves the second with .general).
        if let pending = store.pendingSettingsTab {
            // Validate that the deep-linked tab is actually visible before
            // accepting it. @AppStorage isn't wired to UserDefaults in init,
            // so read connectedOrgId directly from UserDefaults.
            let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
            let canShowBilling = billingEnabled && authManager.isAuthenticated && orgId != nil
            // Contacts and developer flags load asynchronously, so default
            // to false at init time — those tabs aren't visible yet.
            let visibleTabs = SettingsTab.primaryTabs(billingEnabled: canShowBilling, soundsEnabled: soundsEnabled, schedulesEnabled: false)
            if visibleTabs.contains(pending) {
                _selectedTab = State(initialValue: pending)
            } else {
                // Tab may become visible once feature flags load (e.g. .developer).
                // Preserve it for deferred evaluation in loadFeatureFlags().
                _deferredDeepLinkTab = State(initialValue: pending)
            }
        }
    }

    @State private var apiKeyText: String = ""
    @State private var braveKeyText: String = ""
    @State private var perplexityKeyText: String = ""
    @State private var imageGenKeyText: String = ""
    @State private var embeddingKeyText: String = ""

    @State private var showingTrustRules = false
    @State private var accessibilityGranted: Bool = false
    @State private var screenRecordingGranted: Bool = false
    @State private var microphoneGranted: Bool = false
    @State private var speechRecognitionGranted: Bool = false
    @State private var notificationsGranted: Bool = false
    @State private var notificationBadgesGranted: Bool = false
    @State private var permissionCheckTask: Task<Void, Never>?
    @State private var selectedTab: SettingsTab = .general
    /// Deep-linked tab that wasn't visible at init (feature flags not yet loaded).
    /// Re-evaluated after loadFeatureFlags() completes.
    @State private var deferredDeepLinkTab: SettingsTab?
    @State private var isBillingEnabled: Bool = false
    @State private var isSchedulesEnabled: Bool = false
    @State private var isDeveloperEnabled: Bool = false
    @State private var isSoundsEnabled: Bool = true
    @State private var isGoogleOAuthEnabled: Bool = false
    @State private var isEmbeddingProviderEnabled: Bool = false
    @State private var showingDevUnlock: Bool = false
    @State private var devUnlockText: String = ""
    @State private var devUnlockMonitor: Any?
    @State private var bootstrapGeneration: Int = 0
    @AppStorage("connectedOrganizationId") private var connectedOrgId: String?
    private static let schedulesFeatureFlagKey = "feature_flags.settings-schedules.enabled"
    private static let billingFeatureFlagKey = "settings_billing_enabled"
    private static let developerFeatureFlagKey = "feature_flags.settings-developer-nav.enabled"
    private static let googleOAuthFeatureFlagKey = "feature_flags.managed-google-oauth.enabled"
    private static let embeddingProviderFeatureFlagKey = "feature_flags.settings-embedding-provider.enabled"
    private static let soundsFeatureFlagKey = "feature_flags.sounds.enabled"

    var body: some View {
        VStack(spacing: 0) {
            // Header: back chevron + title
            HStack(spacing: VSpacing.md) {
                VButton(
                    label: "Back",
                    iconOnly: VIcon.chevronLeft.rawValue,
                    style: .ghost,
                    tooltip: "Back"
                ) {
                    onClose()
                }

                Text("Settings")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentEmphasized)

                Spacer()
            }
            .padding(.trailing, VSpacing.xl)
            .padding(.bottom, VSpacing.md)

            VColor.borderDisabled.frame(height: 1)
                .padding(.trailing, VSpacing.xl)

            // Body: nav pinned left + centered content with max width
            HStack(alignment: .top, spacing: 0) {
                settingsNav
                    .frame(width: 200)

                ScrollView {
                    selectedTabContent
                        .padding(.top, VSpacing.lg)
                        .padding(.trailing, VSpacing.xl)
                        .padding(.bottom, VSpacing.xl)
                        .frame(maxWidth: 900, alignment: .top)
                        .frame(maxWidth: .infinity)
                        .background { OverlayScrollerStyle() }
                }
                .scrollContentBackground(.hidden)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.top, VSpacing.xl)
        .padding(.leading, VSpacing.xl)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .task {
            // Refresh permission status and feature flags when the view appears
            await refreshPermissionStatus()
            await loadFeatureFlags()
        }
        .onAppear {
            isBillingEnabled = MacOSClientFeatureFlagManager.shared.isEnabled(Self.billingFeatureFlagKey)
            isSoundsEnabled = assistantFeatureFlagStore.isEnabled(Self.soundsFeatureFlagKey)
            isSchedulesEnabled = assistantFeatureFlagStore.isEnabled(Self.schedulesFeatureFlagKey)
            // The init already consumed pendingSettingsTab into selectedTab.
            // Clear the store value so it doesn't leak into future navigations.
            if store.pendingSettingsTab != nil {
                store.pendingSettingsTab = nil
            }
        }
        .onChange(of: store.pendingSettingsTab) { _, newTab in
            if let tab = newTab {
                // Compute visibility inline — same as onAppear. @State
                // mutations (e.g. isBillingEnabled set in onAppear) may not
                // have propagated to computed properties yet, so querying
                // the flag manager directly avoids a stale billingVisible.
                let billingEnabled = MacOSClientFeatureFlagManager.shared.isEnabled(Self.billingFeatureFlagKey)
                let canShowBilling = billingEnabled && authManager.isAuthenticated && connectedOrgId != nil
                let visibleTabs = SettingsTab.primaryTabs(billingEnabled: canShowBilling, soundsEnabled: isSoundsEnabled, schedulesEnabled: isSchedulesEnabled)
                    + (isDeveloperEnabled ? [.developer] : [])
                if visibleTabs.contains(tab) {
                    selectedTab = tab
                }
                store.pendingSettingsTab = nil
            }
        }
        .onDisappear {
            permissionCheckTask?.cancel()
        }
        .onReceive(NotificationCenter.default.publisher(for: .navigateToSettingsTab)) { notification in
            if let tab = notification.object as? SettingsTab {
                guard allVisibleTabs.contains(tab) else { return }
                selectedTab = tab
            }
        }
        .onChange(of: billingVisible) { _, visible in
            if !visible && selectedTab == .billing {
                selectedTab = .general
            }
        }
        .onChange(of: isSoundsEnabled) { _, enabled in
            if !enabled && selectedTab == .sounds {
                selectedTab = .general
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               let enabled = notification.userInfo?["enabled"] as? Bool {
                if key == Self.developerFeatureFlagKey {
                    isDeveloperEnabled = enabled
                    if !enabled && selectedTab == .developer {
                        selectedTab = .general
                    }
                } else if key == Self.billingFeatureFlagKey {
                    isBillingEnabled = enabled
                } else if key == Self.googleOAuthFeatureFlagKey {
                    isGoogleOAuthEnabled = enabled
                } else if key == Self.embeddingProviderFeatureFlagKey {
                    isEmbeddingProviderEnabled = enabled
                } else if key == Self.soundsFeatureFlagKey {
                    isSoundsEnabled = enabled
                    if !enabled && selectedTab == .sounds {
                        selectedTab = .general
                    }
                } else if key == Self.schedulesFeatureFlagKey {
                    isSchedulesEnabled = enabled
                    if !enabled && selectedTab == .schedules {
                        selectedTab = .general
                    }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            // Primary mechanism: Check permissions when app becomes active.
            // This handles the common case where the user grants permission in
            // System Settings and returns to the app via Cmd+Tab or clicking.
            // Uses NSApplication notification instead of scenePhase because this
            // view is hosted in an NSHostingController, not a SwiftUI Scene.
            Task { @MainActor in
                await refreshPermissionStatus()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .localBootstrapCompleted)) { _ in
            bootstrapGeneration += 1
        }
        .sheet(isPresented: $showingTrustRules, onDismiss: { connectionManager?.isTrustRulesSheetOpen = false }) {
            TrustRulesView(trustRuleClient: TrustRuleClient())
        }
        .onAppear {
            devUnlockMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                if event.modifierFlags.contains(.command),
                   event.charactersIgnoringModifiers == "d" {
                    showingDevUnlock = true
                    devUnlockText = ""
                    return nil
                }
                return event
            }
        }
        .onDisappear {
            if let monitor = devUnlockMonitor {
                NSEvent.removeMonitor(monitor)
                devUnlockMonitor = nil
            }
        }
        .popover(isPresented: $showingDevUnlock) {
            VStack(spacing: VSpacing.md) {
                Text("Enter passcode")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                VTextField(
                    placeholder: "",
                    text: $devUnlockText,
                    isSecure: true,
                    onSubmit: {
                        if devUnlockText.lowercased() == "dev" {
                            isDeveloperEnabled = true
                            showingDevUnlock = false
                            // Persist the flag so it survives relaunch
                            Task {
                                do {
                                    if connectionManager != nil {
                                        try await featureFlagClient.setFeatureFlag(key: Self.developerFeatureFlagKey, enabled: true)
                                    } else {
                                        try AssistantFeatureFlagResolver.mergePersistedFlag(
                                            key: Self.developerFeatureFlagKey,
                                            enabled: true
                                        )
                                    }
                                } catch {
                                    // Flag is already set in memory; persistence failure is non-fatal
                                }
                            }
                        }
                        devUnlockText = ""
                    },
                    maxWidth: 160,
                    font: VFont.bodyMediumDefault
                )
            }
            .padding(VSpacing.lg)
        }
    }

    // MARK: - Nav Sidebar

    /// All currently visible tabs (primary + gated bottom tabs).
    private var allVisibleTabs: [SettingsTab] {
        var tabs = SettingsTab.primaryTabs(billingEnabled: billingVisible, soundsEnabled: isSoundsEnabled, schedulesEnabled: isSchedulesEnabled)
        if isDeveloperEnabled {
            tabs.append(.developer)
        }
        // .archivedConversations is already included via primaryTabs()
        return tabs
    }

    private var billingVisible: Bool {
        let _ = bootstrapGeneration  // Force recomputation when bootstrap completes
        return isBillingEnabled && authManager.isAuthenticated && connectedOrgId != nil
    }

    private var settingsNav: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(SettingsTab.primaryTabs(billingEnabled: billingVisible, soundsEnabled: isSoundsEnabled, schedulesEnabled: isSchedulesEnabled), id: \.self) { tab in
                SettingsNavRow(tab: tab, isSelected: selectedTab == tab) {
                    selectedTab = tab
                }
            }
            Spacer(minLength: VSpacing.sm)
            if isDeveloperEnabled {
                VColor.surfaceBase
                    .frame(height: 1)
                    .padding(.vertical, SidebarLayoutMetrics.dividerVerticalPadding)
                    .padding(.trailing, VSpacing.md)
                SettingsNavRow(tab: .developer, isSelected: selectedTab == .developer) {
                    selectedTab = .developer
                }
            }
        }
        .padding(.top, VSpacing.lg)
        .padding(.bottom, VSpacing.xl)
        .padding(.trailing, VSpacing.sm)
    }

    // MARK: - Tab Content Router

    @ViewBuilder
    private var selectedTabContent: some View {
        switch selectedTab {
        case .general:
            SettingsGeneralTab(store: store, connectionManager: connectionManager, authManager: authManager, onClose: onClose, showToast: showToast, onSignIn: {
                // Re-bootstrap actor credentials first so the actor token is
                // available when ensureLocalAssistantApiKey() waits for it.
                // This mirrors the pattern in proceedToApp() and
                // performSwitchAssistant(). Managed assistants derive identity
                // from the platform session, so skip for them.
                if !(AppDelegate.shared?.isCurrentAssistantManaged ?? false) {
                    AppDelegate.shared?.ensureActorCredentials()
                }
                // Reset before provisioning so a stale flag from a previous
                // bootstrap cycle doesn't cause awaitLocalBootstrapCompleted
                // to skip the wait. Mirrors the reset in proceedToApp().
                AppDelegate.shared?.localBootstrapDidComplete = false
                AppDelegate.shared?.ensureLocalAssistantApiKey()
            })
        case .modelsAndServices:
            integrationsContent
        case .voice:
            VoiceSettingsView(store: store)
        case .sounds:
            SettingsSoundsTab()
        case .permissionsAndPrivacy:
            permissionsAndPrivacyContent
        case .billing:
            SettingsBillingTab(authManager: authManager)
        case .archivedConversations:
            SettingsArchivedConversationsTab(conversationManager: conversationManager)
        case .schedules:
            SettingsSchedulesTab()
        case .developer:
            SettingsDeveloperTab(store: store, connectionManager: connectionManager, authManager: authManager, onClose: onClose)
        }
    }

    // MARK: - Integrations Tab

    private var integrationsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Managed services billing info banner
            HStack(spacing: VSpacing.sm) {
                VIconView(.info, size: 14)
                    .foregroundStyle(VColor.primaryBase)

                Text("Managed services are metered and deducted from your Vellum account balance.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)

                Button {
                    NSWorkspace.shared.open(URL(string: "https://vellum.ai/docs/pricing")!)
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Text("View pricing")
                            .underline()
                        VIconView(.arrowUpRight, size: 10)
                    }
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.primaryBase)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )

            // ANTHROPIC / INFERENCE
            InferenceServiceCard(
                store: store,
                authManager: authManager,
                apiKeyText: $apiKeyText,
                showToast: showToast
            )

            // WEB SEARCH
            WebSearchServiceCard(
                store: store,
                authManager: authManager,
                perplexityKeyText: $perplexityKeyText,
                braveKeyText: $braveKeyText,
                showToast: showToast
            )

            // IMAGE GENERATION
            ImageGenerationServiceCard(
                store: store,
                authManager: authManager,
                apiKeyText: $imageGenKeyText,
                showToast: showToast
            )

            // EMBEDDING (feature-flagged)
            if isEmbeddingProviderEnabled {
                EmbeddingServiceCard(
                    store: store,
                    apiKeyText: $embeddingKeyText,
                    showToast: showToast
                )
            }

            // GOOGLE OAUTH (feature-flagged)
            if isGoogleOAuthEnabled {
                Divider()
                    .background(VColor.borderBase)
                    .padding(.vertical, VSpacing.sm)

                OAuthProviderServiceCard(store: store, authManager: authManager, showToast: showToast, providerKey: "integration:google")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            store.refreshAPIKeyState()
            store.refreshVercelKeyState()
            store.refreshModelInfo()
            store.loadProviderRoutingSources()
            store.refreshEmbeddingConfig()
        }
    }

    // MARK: - Permissions & Privacy Tab

    private var permissionsAndPrivacyContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // PERMISSIONS section (OS permissions)
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("System Permissions")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)

                permissionRow(
                    label: "Accessibility",
                    subtitle: "Allows your assistant to click, type, and control apps on your behalf.",
                    granted: accessibilityGranted
                ) {
                    if accessibilityGranted {
                        PermissionManager.openAccessibilitySettings()
                    } else {
                        _ = PermissionManager.accessibilityStatus(prompt: true)
                    }
                    startPermissionPolling()
                }

                permissionRow(
                    label: "Screen Recording",
                    subtitle: "Allows your assistant to capture screen context during computer-use tasks.",
                    granted: screenRecordingGranted
                ) {
                    PermissionManager.requestScreenRecordingAccess()
                    startPermissionPolling()
                }

                permissionRow(
                    label: "Microphone",
                    subtitle: "Allows your assistant to capture audio for voice input and recordings.",
                    granted: microphoneGranted
                ) {
                    PermissionManager.requestMicrophoneAccess()
                    startPermissionPolling()
                }

                permissionRow(
                    label: "Speech Recognition",
                    subtitle: "Allows your assistant to transcribe your speech into text on-device.",
                    granted: speechRecognitionGranted
                ) {
                    PermissionManager.requestSpeechRecognitionAccess()
                    startPermissionPolling()
                }

                permissionRow(
                    label: "Notifications",
                    subtitle: "Allows your assistant to send macOS alerts for approvals, messages, and task updates.",
                    granted: notificationsGranted
                ) {
                    PermissionManager.requestNotificationAccess()
                    startPermissionPolling()
                }

                permissionRow(
                    label: "Notification Badges",
                    subtitle: "Allows your assistant to show unseen conversation counts on the Dock icon.",
                    granted: notificationBadgesGranted
                ) {
                    PermissionManager.requestNotificationBadgeAccess()
                    startPermissionPolling()
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceOverlay)

            // TRUST RULES section
            if connectionManager != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trust Rules")
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentDefault)
                        Text("Control which tool actions are automatically allowed or denied")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    VButton(label: "Manage", style: .outlined) {
                        connectionManager?.isTrustRulesSheetOpen = true
                        showingTrustRules = true
                    }
                    .disabled(store.isAnyTrustRulesSheetOpen)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceOverlay)
            }

            // PRIVACY section
            SettingsPrivacyTab(store: store)

        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Permission Row

    private func permissionRow(label: String, subtitle: String, granted: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VToggle(isOn: .constant(granted), label: label, helperText: subtitle, interactive: false)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Permission Helpers

    private func refreshPermissionStatus() async {
        accessibilityGranted = PermissionManager.accessibilityStatus() == .granted
        screenRecordingGranted = PermissionManager.screenRecordingStatus() == .granted
        microphoneGranted = PermissionManager.microphoneStatus() == .granted
        speechRecognitionGranted = PermissionManager.speechRecognitionStatus() == .granted
        notificationsGranted = await PermissionManager.notificationStatus() == .granted
        notificationBadgesGranted = await PermissionManager.notificationBadgeStatus() == .granted
    }

    // MARK: - Feature Flag Loading

    private func loadFeatureFlags() async {
        if connectionManager != nil {
            do {
                let flags = try await featureFlagClient.getFeatureFlags()
                if let developerFlag = flags.first(where: { $0.key == Self.developerFeatureFlagKey }) {
                    isDeveloperEnabled = developerFlag.enabled
                }
                if let googleOAuthFlag = flags.first(where: { $0.key == Self.googleOAuthFeatureFlagKey }) {
                    isGoogleOAuthEnabled = googleOAuthFlag.enabled
                }
                if let embeddingProviderFlag = flags.first(where: { $0.key == Self.embeddingProviderFeatureFlagKey }) {
                    isEmbeddingProviderEnabled = embeddingProviderFlag.enabled
                }
                if let soundsFlag = flags.first(where: { $0.key == Self.soundsFeatureFlagKey }) {
                    isSoundsEnabled = soundsFlag.enabled
                }
                if let schedulesFlag = flags.first(where: { $0.key == Self.schedulesFeatureFlagKey }) {
                    isSchedulesEnabled = schedulesFlag.enabled
                }
                consumeDeferredDeepLinkIfVisible()
                return
            } catch {
                // Fall through to local config fallback.
            }
        }
        // Build resolved values: start with bundled registry defaults, then overlay persisted overrides
        let resolved = AssistantFeatureFlagResolver.resolvedFlags(
            registry: loadFeatureFlagRegistry()
        )

        if let developerEnabled = resolved[Self.developerFeatureFlagKey] {
            isDeveloperEnabled = developerEnabled
        }
        if let googleOAuthEnabled = resolved[Self.googleOAuthFeatureFlagKey] {
            isGoogleOAuthEnabled = googleOAuthEnabled
        }
        if let embeddingProviderEnabled = resolved[Self.embeddingProviderFeatureFlagKey] {
            isEmbeddingProviderEnabled = embeddingProviderEnabled
        }
        if let soundsEnabled = resolved[Self.soundsFeatureFlagKey] {
            isSoundsEnabled = soundsEnabled
        }
        if let schedulesEnabled = resolved[Self.schedulesFeatureFlagKey] {
            isSchedulesEnabled = schedulesEnabled
        }

        consumeDeferredDeepLinkIfVisible()
    }

    /// If a deep-linked tab was deferred at init because its feature flag
    /// hadn't loaded, check whether it's now visible and navigate to it.
    private func consumeDeferredDeepLinkIfVisible() {
        guard let deferred = deferredDeepLinkTab else { return }
        let visibleTabs = allVisibleTabs
        if visibleTabs.contains(deferred) {
            selectedTab = deferred
        }
        deferredDeepLinkTab = nil
    }

    private func startPermissionPolling() {
        // Hybrid permission checking approach:
        // 1. Primary: NSApplication.didBecomeActiveNotification detects when user
        //    returns from System Settings
        // 2. Fallback: Poll every 1 second for 15 seconds to catch edge cases where
        //    the notification doesn't fire (e.g., user grants permission while app
        //    stays focused)
        permissionCheckTask?.cancel()

        permissionCheckTask = Task { @MainActor in
            // Poll for up to 15 seconds (typical time for user to navigate System Settings)
            for _ in 0..<15 {
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second

                guard !Task.isCancelled else { return }
                await refreshPermissionStatus()
            }
        }
    }

}

// MARK: - Settings Nav Row

private struct SettingsNavRow: View {
    let tab: SettingsTab
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack {
                Text(tab.rawValue)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                Spacer()
            }
            .padding(.leading, VSpacing.sm)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                (isSelected ? VColor.surfaceActive : VColor.surfaceBase.opacity(isHovered ? 1 : 0))
                    .animation(VAnimation.fast, value: isHovered)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.trailing, VSpacing.md)
        .onHover { hovering in
            isHovered = hovering
        }
        .pointerCursor()
    }
}

// MARK: - Environment Variables Sheet

struct SettingsPanelEnvVarsSheet: View {
    let appEnvVars: [(String, String)]
    let daemonEnvVars: [(String, String)]
    @Environment(\.dismiss) var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Environment Variables")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                VButton(label: "Done", style: .outlined) { dismiss() }
            }
            .padding(VSpacing.lg)

            Divider().background(VColor.borderBase)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    envVarsSection(title: "App Process", vars: appEnvVars)
                    envVarsSection(title: "Daemon Process", vars: daemonEnvVars)
                }
                .padding(VSpacing.lg)
            }
        }
        .frame(width: 600, height: 500)
        .background(VColor.surfaceOverlay)
    }

    private func envVarsSection(title: String, vars: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(title)
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            if vars.isEmpty {
                Text("Loading...")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            } else {
                ForEach(vars, id: \.0) { key, value in
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Text(key)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .frame(width: 200, alignment: .trailing)
                        Text(value)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .textSelection(.enabled)
                        Spacer()
                    }
                }
            }
        }
    }
}

/// Sets the enclosing NSScrollView to overlay style — thin scroller, no track background.
struct OverlayScrollerStyle: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let scrollView = view.enclosingScrollView else { return }
            scrollView.scrollerStyle = .overlay
            scrollView.scrollerKnobStyle = .default
            scrollView.hasHorizontalScroller = false
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

