import SwiftUI
import VellumAssistantShared

enum SettingsTab: String {
    case general = "General"
    case modelsAndServices = "Models & Services"
    case voice = "Voice"
    case permissionsAndPrivacy = "Permissions & Privacy"
    case contacts = "Contacts"
    case billing = "Billing"
    case archivedConversations = "Archived Threads"
    case developer = "Developer"

    /// Primary tabs shown in the main nav list (excludes feature-flagged bottom tabs).
    static func primaryTabs(contactsEnabled: Bool = false, billingEnabled: Bool = false) -> [SettingsTab] {
        var tabs: [SettingsTab] = [.general]
        if contactsEnabled {
            tabs.append(.contacts)
        }
        tabs.append(contentsOf: [
            .voice, .modelsAndServices,
            .permissionsAndPrivacy,
        ])
        if billingEnabled {
            tabs.append(.billing)
        }
        tabs.append(.archivedConversations)
        return tabs
    }

    /// Resolves a tab name string to a SettingsTab. Only accepts current canonical names.
    static func fromRawValue(_ value: String, contactsEnabled: Bool = false, billingEnabled: Bool = false, developerEnabled: Bool = false) -> SettingsTab? {
        guard let tab = SettingsTab(rawValue: value) else { return nil }
        // Block feature-flagged tabs when disabled
        if tab == .contacts && !contactsEnabled { return nil }
        if tab == .billing && !billingEnabled { return nil }
        if tab == .developer && !developerEnabled { return nil }
        return tab
    }
}

@MainActor
struct SettingsPanel: View {
    var onClose: () -> Void
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    @ObservedObject var conversationManager: ConversationManager
    var authManager: AuthManager

    @State private var apiKeyText: String = ""
    @State private var braveKeyText: String = ""
    @State private var perplexityKeyText: String = ""
    @State private var imageGenKeyText: String = ""

    @State private var showingTrustRules = false
    @State private var accessibilityGranted: Bool = false
    @State private var screenRecordingGranted: Bool = false
    @State private var microphoneGranted: Bool = false
    @State private var speechRecognitionGranted: Bool = false
    @State private var notificationsGranted: Bool = false
    @State private var notificationBadgesGranted: Bool = false
    @State private var permissionCheckTask: Task<Void, Never>?
    @State private var selectedTab: SettingsTab = .general
    @State private var isContactsEnabled: Bool = false
    @State private var isBillingEnabled: Bool = false
    @State private var isDeveloperEnabled: Bool = false
    @State private var isEmailEnabled: Bool = false
    @State private var showingDevUnlock: Bool = false
    @State private var devUnlockText: String = ""
    @State private var devUnlockMonitor: Any?
    @State private var bootstrapGeneration: Int = 0
    @AppStorage("connectedOrganizationId") private var connectedOrgId: String?
    private static let contactsFeatureFlagKey = "feature_flags.contacts.enabled"
    private static let billingFeatureFlagKey = "settings_billing_enabled"
    private static let developerFeatureFlagKey = "feature_flags.settings-developer-nav.enabled"
    private static let emailFeatureFlagKey = "feature_flags.email-channel.enabled"

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
                    .font(VFont.panelTitle)
                    .foregroundColor(VColor.contentEmphasized)

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

                if selectedTab == .contacts || (selectedTab == .archivedConversations && conversationManager.archivedConversations.isEmpty) {
                    selectedTabContent
                        .padding(.trailing, VSpacing.xl)
                        .padding(.bottom, VSpacing.xl)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: selectedTab == .contacts ? .top : .center)
                } else {
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
            store.refreshAPIKeyState()
            store.loadProviderRoutingSources()
            store.refreshTelegramStatus()
            store.refreshTwilioStatus()
            store.refreshIngressConfig()
            if let pending = store.pendingSettingsTab {
                if allVisibleTabs.contains(pending) {
                    selectedTab = pending
                }
                store.pendingSettingsTab = nil
            }
        }
        .onChange(of: store.pendingSettingsTab) { _, newTab in
            if let tab = newTab {
                if allVisibleTabs.contains(tab) {
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
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               let enabled = notification.userInfo?["enabled"] as? Bool {
                if key == Self.contactsFeatureFlagKey {
                    isContactsEnabled = enabled
                    if !enabled && selectedTab == .contacts {
                        selectedTab = .general
                    }
                } else if key == Self.developerFeatureFlagKey {
                    isDeveloperEnabled = enabled
                    if !enabled && selectedTab == .developer {
                        selectedTab = .general
                    }
                } else if key == Self.billingFeatureFlagKey {
                    isBillingEnabled = enabled
                } else if key == Self.emailFeatureFlagKey {
                    isEmailEnabled = enabled
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
        .sheet(isPresented: $showingTrustRules) {
            if let daemonClient {
                TrustRulesView(daemonClient: daemonClient)
            }
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
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                SecureField("", text: $devUnlockText)
                    .vInputStyle()
                    .font(VFont.mono)
                    .frame(width: 160)
                    .onSubmit {
                        if devUnlockText.lowercased() == "dev" {
                            isDeveloperEnabled = true
                            showingDevUnlock = false
                            // Persist the flag so it survives relaunch
                            Task {
                                do {
                                    if let daemonClient {
                                        try await daemonClient.setFeatureFlag(key: Self.developerFeatureFlagKey, enabled: true)
                                    } else {
                                        try WorkspaceConfigIO.merge([
                                            "assistantFeatureFlagValues": [Self.developerFeatureFlagKey: true]
                                        ])
                                    }
                                } catch {
                                    // Flag is already set in memory; persistence failure is non-fatal
                                }
                            }
                        }
                        devUnlockText = ""
                    }
            }
            .padding(VSpacing.lg)
        }
    }

    // MARK: - Nav Sidebar

    /// All currently visible tabs (primary + gated bottom tabs).
    private var allVisibleTabs: [SettingsTab] {
        var tabs = SettingsTab.primaryTabs(contactsEnabled: isContactsEnabled, billingEnabled: billingVisible)
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
            ForEach(SettingsTab.primaryTabs(contactsEnabled: isContactsEnabled, billingEnabled: billingVisible), id: \.self) { tab in
                SettingsNavRow(tab: tab, isSelected: selectedTab == tab) {
                    selectedTab = tab
                }
            }
            Spacer()
            if isDeveloperEnabled {
                Divider()
                    .padding(.trailing, VSpacing.md)
                SettingsNavRow(tab: .developer, isSelected: selectedTab == .developer) {
                    selectedTab = .developer
                }
                .padding(.bottom, VSpacing.sm)
            }
        }
        .padding(.top, VSpacing.lg)
        .padding(.trailing, VSpacing.sm)
    }

    // MARK: - Tab Content Router

    @ViewBuilder
    private var selectedTabContent: some View {
        switch selectedTab {
        case .general:
            SettingsGeneralTab(store: store, daemonClient: daemonClient, authManager: authManager, onClose: onClose, onSignIn: {
                // Re-bootstrap actor credentials first so the actor token is
                // available when ensureLocalAssistantApiKey() waits for it.
                // This mirrors the pattern in proceedToApp() and
                // performSwitchAssistant(). Managed assistants derive identity
                // from the platform session, so skip for them.
                if !(AppDelegate.shared?.isCurrentAssistantManaged ?? false) {
                    AppDelegate.shared?.ensureActorCredentials()
                }
                AppDelegate.shared?.ensureLocalAssistantApiKey()
            })
        case .modelsAndServices:
            integrationsContent
        case .voice:
            VoiceSettingsView(store: store)
        case .permissionsAndPrivacy:
            permissionsAndPrivacyContent
        case .contacts:
            ContactsContainerView(daemonClient: daemonClient, store: store, isEmailEnabled: isEmailEnabled)
        case .billing:
            SettingsBillingTab(authManager: authManager)
        case .archivedConversations:
            SettingsArchivedConversationsTab(conversationManager: conversationManager)
        case .developer:
            SettingsDeveloperTab(store: store, daemonClient: daemonClient, authManager: authManager, onClose: onClose)
        }
    }

    // MARK: - Integrations Tab

    private var integrationsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // ANTHROPIC / INFERENCE
            InferenceServiceCard(
                store: store,
                authManager: authManager,
                apiKeyText: $apiKeyText
            )

            // PERPLEXITY SEARCH
            ServiceCredentialCard(
                title: "Perplexity Search",
                subtitle: "Enables real-time web search in responses",
                isConnected: store.hasPerplexityKey,
                keyPlaceholder: "Enter your Perplexity API key",
                isManagedProxy: store.providerRoutingSources["perplexity"] == "managed-proxy",
                keyText: $perplexityKeyText,
                onSave: {
                    store.savePerplexityKey(perplexityKeyText)
                    perplexityKeyText = ""
                },
                onReset: {
                    store.clearPerplexityKey()
                    perplexityKeyText = ""
                }
            )

            // BRAVE SEARCH
            ServiceCredentialCard(
                title: "Brave Search",
                subtitle: "Enables private web search in responses",
                isConnected: store.hasBraveKey,
                keyPlaceholder: "Enter your Brave Search API key",
                isManagedProxy: store.providerRoutingSources["brave"] == "managed-proxy",
                keyText: $braveKeyText,
                onSave: {
                    store.saveBraveKey(braveKeyText)
                    braveKeyText = ""
                },
                onReset: {
                    store.clearBraveKey()
                    braveKeyText = ""
                }
            )

            // IMAGE GENERATION
            ServiceCredentialCard(
                title: "Image Generation",
                subtitle: "Enables AI image generation via Gemini",
                isConnected: store.hasImageGenKey,
                keyPlaceholder: "Enter your Gemini API key",
                isManagedProxy: store.providerRoutingSources["gemini"] == "managed-proxy",
                keyText: $imageGenKeyText,
                onSave: {
                    store.saveImageGenKey(imageGenKeyText)
                    imageGenKeyText = ""
                },
                onReset: {
                    store.clearImageGenKey()
                    imageGenKeyText = ""
                }
            ) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Model")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Select a model…",
                        selection: Binding(
                            get: { store.selectedImageGenModel },
                            set: { store.setImageGenModel($0) }
                        ),
                        options: SettingsStore.availableImageGenModels.map { model in
                            (label: SettingsStore.imageGenModelDisplayNames[model] ?? model, value: model)
                        }
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Permissions & Privacy Tab

    private var permissionsAndPrivacyContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // PERMISSIONS section (OS permissions)
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("System Permissions")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentDefault)

                permissionRow(
                    label: "Accessibility",
                    subtitle: "Allows your assistant to click, type, and control apps on your behalf.",
                    granted: accessibilityGranted
                ) {
                    _ = PermissionManager.accessibilityStatus(prompt: true)
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
            if daemonClient != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Trust Rules")
                            .font(VFont.sectionTitle)
                            .foregroundColor(VColor.contentDefault)
                        Text("Control which tool actions are automatically allowed or denied")
                            .font(VFont.sectionDescription)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    VButton(label: "Manage", style: .outlined) {
                        daemonClient?.isTrustRulesSheetOpen = true
                        showingTrustRules = true
                    }
                    .disabled(store.isAnyTrustRulesSheetOpen)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceOverlay)
            }

            // PRIVACY section (merged from SettingsPrivacyTab)
            SettingsPrivacyTab(daemonClient: daemonClient, store: store)

        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Permission Row

    private func permissionRow(label: String, subtitle: String, granted: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VToggle(isOn: .constant(granted), label: label, helperText: subtitle)
                .allowsHitTesting(false)
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
        if let daemonClient {
            do {
                let flags = try await daemonClient.getFeatureFlags()
                if let contactsFlag = flags.first(where: { $0.key == Self.contactsFeatureFlagKey }) {
                    isContactsEnabled = contactsFlag.enabled
                }
                if let developerFlag = flags.first(where: { $0.key == Self.developerFeatureFlagKey }) {
                    isDeveloperEnabled = developerFlag.enabled
                }
                if let emailFlag = flags.first(where: { $0.key == Self.emailFeatureFlagKey }) {
                    isEmailEnabled = emailFlag.enabled
                }
                return
            } catch {
                // Fall through to local config fallback.
            }
        }
        // Build resolved values: start with bundled registry defaults, then overlay persisted overrides
        let registry = loadFeatureFlagRegistry()
        let registryDefaults = Dictionary(
            uniqueKeysWithValues: (registry?.assistantScopeFlags() ?? []).map { ($0.key, $0.defaultEnabled) }
        )
        let config = WorkspaceConfigIO.read()
        let persistedFlags = (config["assistantFeatureFlagValues"] as? [String: Bool]) ?? [:]
        let resolved = registryDefaults.merging(persistedFlags) { _, persisted in persisted }

        if let contactsEnabled = resolved[Self.contactsFeatureFlagKey] {
            isContactsEnabled = contactsEnabled
        }
        if let developerEnabled = resolved[Self.developerFeatureFlagKey] {
            isDeveloperEnabled = developerEnabled
        }
        if let emailEnabled = resolved[Self.emailFeatureFlagKey] {
            isEmailEnabled = emailEnabled
        }
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
                    .font(VFont.body)
                    .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
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
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)
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
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)
            if vars.isEmpty {
                Text("Loading...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            } else {
                ForEach(vars, id: \.0) { key, value in
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Text(key)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentSecondary)
                            .frame(width: 200, alignment: .trailing)
                        Text(value)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.contentTertiary)
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

