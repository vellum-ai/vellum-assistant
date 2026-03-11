import SwiftUI
import VellumAssistantShared

enum SettingsTab: String {
    case general = "General"
    case channels = "Channels"
    case modelsAndServices = "Models & Services"
    case voice = "Voice"
    case permissionsAndPrivacy = "Permissions & Privacy"
    case contacts = "Contacts"
    case developer = "Developer"

    /// Primary tabs shown in the main nav list (excludes feature-flagged bottom tabs).
    static func primaryTabs(contactsEnabled: Bool = false) -> [SettingsTab] {
        var tabs: [SettingsTab] = [
            .general, .channels, .modelsAndServices, .voice,
            .permissionsAndPrivacy
        ]
        if contactsEnabled {
            tabs.append(.contacts)
        }
        return tabs
    }

    /// Resolves a tab name string to a SettingsTab. Only accepts current canonical names.
    static func fromRawValue(_ value: String, contactsEnabled: Bool = false, developerEnabled: Bool = false) -> SettingsTab? {
        guard let tab = SettingsTab(rawValue: value) else { return nil }
        // Block feature-flagged tabs when disabled
        if tab == .contacts && !contactsEnabled { return nil }
        if tab == .developer && !developerEnabled { return nil }
        return tab
    }
}

@MainActor
struct SettingsPanel: View {
    var onClose: () -> Void
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    @ObservedObject var threadManager: ThreadManager
    var authManager: AuthManager

    @State private var apiKeyText: String = ""
    @State private var braveKeyText: String = ""
    @State private var perplexityKeyText: String = ""
    @State private var imageGenKeyText: String = ""

    // Setup expanded state for Models & Services credential cards
    @State private var anthropicSetupExpanded = false
    @State private var perplexitySetupExpanded = false
    @State private var braveSetupExpanded = false
    @State private var imageGenSetupExpanded = false
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
    @State private var isDeveloperEnabled: Bool = false
    private static let contactsFeatureFlagKey = "feature_flags.contacts.enabled"
    private static let developerFeatureFlagKey = "feature_flags.settings-developer-nav.enabled"

    var body: some View {
        VStack(spacing: 0) {
            // Header: back chevron + title
            HStack(spacing: VSpacing.md) {
                Button(action: onClose) {
                    VIconView(.chevronLeft, size: 16)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(VColor.textSecondary)
                .pointerCursor()
                .accessibilityLabel("Back")

                Text("Settings")
                    .font(VFont.panelTitle)
                    .foregroundColor(VColor.textPrimary)

                Spacer()
            }
            .padding(.trailing, VSpacing.xl)
            .padding(.bottom, VSpacing.md)

            VColor.surfaceBorder.frame(height: 1)
                .padding(.trailing, VSpacing.xl)

            // Body: nav pinned left + centered content with max width
            HStack(alignment: .top, spacing: 0) {
                settingsNav
                    .frame(width: 200)

                if selectedTab == .contacts {
                    selectedTabContent
                        .padding(.trailing, VSpacing.xl)
                        .padding(.bottom, VSpacing.xl)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                } else {
                    ScrollView {
                        selectedTabContent
                            .padding(.top, VSpacing.lg)
                            .padding(.leading, VSpacing.lg)
                            .padding(.trailing, VSpacing.xl)
                            .padding(.bottom, VSpacing.xl)
                            .frame(maxWidth: 700, alignment: .top)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.top, VSpacing.xl)
        .padding(.leading, VSpacing.xl)
        .background(VColor.backgroundSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .task {
            // Refresh permission status and feature flags when the view appears
            await refreshPermissionStatus()
            await loadFeatureFlags()
        }
        .onAppear {
            store.refreshAPIKeyState()
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
        .sheet(isPresented: $showingTrustRules) {
            if let daemonClient {
                TrustRulesView(daemonClient: daemonClient)
            }
        }
    }

    // MARK: - Nav Sidebar

    /// All currently visible tabs (primary + gated bottom tabs).
    private var allVisibleTabs: [SettingsTab] {
        var tabs = SettingsTab.primaryTabs(contactsEnabled: isContactsEnabled)
        if isDeveloperEnabled {
            tabs.append(.developer)
        }
        return tabs
    }

    private var settingsNav: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(SettingsTab.primaryTabs(contactsEnabled: isContactsEnabled), id: \.self) { tab in
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
            SettingsGeneralTab(store: store, daemonClient: daemonClient, authManager: authManager, onClose: onClose)
        case .channels:
            SettingsChannelsTab(store: store, daemonClient: daemonClient)
        case .modelsAndServices:
            integrationsContent
        case .voice:
            VoiceSettingsView(store: store)
        case .permissionsAndPrivacy:
            permissionsAndPrivacyContent
        case .contacts:
            ContactsContainerView(daemonClient: daemonClient, store: store)
        case .developer:
            SettingsDeveloperTab(store: store, daemonClient: daemonClient, authManager: authManager, onClose: onClose)
        }
    }

    // MARK: - Integrations Tab

    private var integrationsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // ANTHROPIC section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Anthropic")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)
                    Text("Required for AI responses")
                        .font(VFont.sectionDescription)
                        .foregroundColor(VColor.textMuted)
                }

                if store.hasKey {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("Active Model")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)
                        VDropdown(
                            placeholder: "Select a model…",
                            selection: Binding(
                                get: { store.selectedModel },
                                set: { model in
                                    store.selectedModel = model
                                    store.setModel(model)
                                }
                            ),
                            options: SettingsStore.availableModels.map { model in
                                (label: SettingsStore.modelDisplayNames[model] ?? model, value: model)
                            }
                        )
                        .frame(width: 360)
                    }

                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
                        VButton(label: "Clear", style: .danger) {
                            store.clearAPIKey()
                            apiKeyText = ""
                            anthropicSetupExpanded = false
                        }
                    }
                } else if anthropicSetupExpanded {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("API Key")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)

                        SecureField("This is your private generated key", text: $apiKeyText)
                            .vInputStyle()
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)

                        HStack(spacing: 0) {
                            Text("Get your API key at ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Link("console.anthropic.com", destination: URL(string: "https://console.anthropic.com")!)
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                                .pointerCursor()
                        }

                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Save", style: .secondary) {
                                store.saveAPIKey(apiKeyText)
                                apiKeyText = ""
                                anthropicSetupExpanded = false
                            }
                            .disabled(apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            VButton(label: "Cancel", style: .tertiary) {
                                apiKeyText = ""
                                anthropicSetupExpanded = false
                            }
                        }
                    }
                } else {
                    VButton(label: "Set Up", style: .secondary) {
                        anthropicSetupExpanded = true
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)

            // PERPLEXITY SEARCH section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Perplexity Search")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)
                    Text("Enables real-time web search in responses")
                        .font(VFont.sectionDescription)
                        .foregroundColor(VColor.textMuted)
                }

                if store.hasPerplexityKey {
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
                        VButton(label: "Clear", style: .danger) {
                            store.clearPerplexityKey()
                            perplexityKeyText = ""
                            perplexitySetupExpanded = false
                        }
                    }
                } else if perplexitySetupExpanded {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("API Key")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)

                        SecureField("Your Perplexity API key", text: $perplexityKeyText)
                            .vInputStyle()
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)

                        HStack(spacing: 0) {
                            Text("Get your API key at ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Link("perplexity.ai/settings/api", destination: URL(string: "https://perplexity.ai/settings/api")!)
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                                .pointerCursor()
                        }

                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Save", style: .secondary) {
                                store.savePerplexityKey(perplexityKeyText)
                                perplexityKeyText = ""
                                perplexitySetupExpanded = false
                            }
                            .disabled(perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            VButton(label: "Cancel", style: .tertiary) {
                                perplexityKeyText = ""
                                perplexitySetupExpanded = false
                            }
                        }
                    }
                } else {
                    VButton(label: "Set Up", style: .secondary) {
                        perplexitySetupExpanded = true
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)

            // BRAVE SEARCH section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Brave Search")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)
                    Text("Enables private web search in responses")
                        .font(VFont.sectionDescription)
                        .foregroundColor(VColor.textMuted)
                }

                if store.hasBraveKey {
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
                        VButton(label: "Clear", style: .danger) {
                            store.clearBraveKey()
                            braveKeyText = ""
                            braveSetupExpanded = false
                        }
                    }
                } else if braveSetupExpanded {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("API Key")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)

                        SecureField("Your Brave Search API key", text: $braveKeyText)
                            .vInputStyle()
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)

                        HStack(spacing: 0) {
                            Text("Get your API key at ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Link("brave.com/search/api", destination: URL(string: "https://brave.com/search/api")!)
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                                .pointerCursor()
                        }

                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Save", style: .secondary) {
                                store.saveBraveKey(braveKeyText)
                                braveKeyText = ""
                                braveSetupExpanded = false
                            }
                            .disabled(braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            VButton(label: "Cancel", style: .tertiary) {
                                braveKeyText = ""
                                braveSetupExpanded = false
                            }
                        }
                    }
                } else {
                    VButton(label: "Set Up", style: .secondary) {
                        braveSetupExpanded = true
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)

            // IMAGE GENERATION section
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Image Generation")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)
                    Text("Enables AI image generation via Gemini")
                        .font(VFont.sectionDescription)
                        .foregroundColor(VColor.textMuted)
                }

                if store.hasImageGenKey {
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Connected", leftIcon: VIcon.circleCheck.rawValue, style: .success) {}
                        VButton(label: "Clear", style: .danger) {
                            store.clearImageGenKey()
                            imageGenKeyText = ""
                            imageGenSetupExpanded = false
                        }
                    }

                    Divider()
                        .background(VColor.surfaceBorder)

                    HStack {
                        Text("Model")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Picker("", selection: Binding(
                            get: { store.selectedImageGenModel },
                            set: { store.setImageGenModel($0) }
                        )) {
                            ForEach(SettingsStore.availableImageGenModels, id: \.self) { model in
                                Text(SettingsStore.imageGenModelDisplayNames[model] ?? model)
                                    .tag(model)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
                    }
                } else if imageGenSetupExpanded {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("API Key")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.textSecondary)

                        SecureField("Your Gemini API key", text: $imageGenKeyText)
                            .vInputStyle()
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)

                        HStack(spacing: 0) {
                            Text("Get your API key at ")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                            Link("aistudio.google.com/apikey", destination: URL(string: "https://aistudio.google.com/apikey")!)
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                                .pointerCursor()
                        }

                        HStack(spacing: VSpacing.sm) {
                            VButton(label: "Save", style: .secondary) {
                                store.saveImageGenKey(imageGenKeyText)
                                imageGenKeyText = ""
                                imageGenSetupExpanded = false
                            }
                            .disabled(imageGenKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            VButton(label: "Cancel", style: .tertiary) {
                                imageGenKeyText = ""
                                imageGenSetupExpanded = false
                            }
                        }
                    }
                } else {
                    VButton(label: "Set Up", style: .secondary) {
                        imageGenSetupExpanded = true
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .vCard(background: VColor.surfaceSubtle)

        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Permissions & Privacy Tab

    private var permissionsAndPrivacyContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // PERMISSIONS section (OS permissions)
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("macOS System Permissions")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

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
            .vCard(background: VColor.surfaceSubtle)

            // TRUST RULES section
            if daemonClient != nil {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Trust Rules")
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.textPrimary)

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            Text("Manage Trust Rules")
                                .font(VFont.body)
                                .foregroundColor(VColor.textSecondary)
                            Text("Control which tool actions are automatically allowed or denied")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                        }
                        VButton(label: "Manage", style: .secondary) {
                            daemonClient?.isTrustRulesSheetOpen = true
                            showingTrustRules = true
                        }
                        .disabled(store.isAnyTrustRulesSheetOpen)
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard(background: VColor.surfaceSubtle)
            }

            // PRIVACY section (merged from SettingsPrivacyTab)
            SettingsPrivacyTab(daemonClient: daemonClient, store: store)

        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Permission Row

    private func permissionRow(label: String, subtitle: String, granted: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(label)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                VToggle(isOn: .constant(granted)).allowsHitTesting(false)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
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
                    .foregroundColor(VColor.textPrimary)
                Spacer()
            }
            .padding(.leading, VSpacing.sm)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, SidebarLayoutMetrics.rowVerticalPadding)
            .frame(minHeight: SidebarLayoutMetrics.rowMinHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                (isSelected ? VColor.navActive : VColor.navHover.opacity(isHovered ? 1 : 0))
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
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                VButton(label: "Done", style: .tertiary) { dismiss() }
            }
            .padding(VSpacing.lg)

            Divider().background(VColor.surfaceBorder)

            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    envVarsSection(title: "App Process", vars: appEnvVars)
                    envVarsSection(title: "Daemon Process", vars: daemonEnvVars)
                }
                .padding(VSpacing.lg)
            }
        }
        .frame(width: 600, height: 500)
        .background(VColor.background)
    }

    private func envVarsSection(title: String, vars: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(title)
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)
            if vars.isEmpty {
                Text("Loading...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            } else {
                ForEach(vars, id: \.0) { key, value in
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Text(key)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textSecondary)
                            .frame(width: 200, alignment: .trailing)
                        Text(value)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textMuted)
                            .textSelection(.enabled)
                        Spacer()
                    }
                }
            }
        }
    }
}

struct SettingsPanel_Previews: PreviewProvider {
    static var previews: some View {
        let dc = DaemonClient()
        ZStack {
            VColor.background.ignoresSafeArea()
            SettingsPanel(onClose: {}, store: SettingsStore(daemonClient: dc), threadManager: ThreadManager(daemonClient: dc), authManager: AuthManager())
        }
        .frame(width: 600, height: 700)
    }
}
