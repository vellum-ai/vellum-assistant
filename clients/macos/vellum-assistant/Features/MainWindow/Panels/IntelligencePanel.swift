import SwiftUI
import VellumAssistantShared

// MARK: - Intelligence Panel

struct IntelligencePanel: View {
    var onClose: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onCreateSkill: (() -> Void)?
    let connectionManager: GatewayConnectionManager
    let eventStreamClient: EventStreamClient?
    var store: SettingsStore?
    var conversationManager: ConversationManager?
    var authManager: AuthManager?
    var showToast: ((String, ToastInfo.Style) -> Void)?
    var initialTab: String? = nil
    @Binding var pendingMemoryId: String?

    @State private var selectedTab: IntelligenceTab
    @State private var cachedAssistantName: String = "Your Assistant"
    @State private var isEmailEnabled: Bool = false
    @State private var isIntegrationsTabEnabled: Bool = false
    @Binding var pendingSkillId: String?
    @State private var pendingFilePath: String?
    private static let emailFeatureFlagKey = "email-channel"
    private static let integrationsFeatureFlagKey = "settings-integrations-grid"

    init(onClose: @escaping () -> Void, onInvokeSkill: ((SkillInfo) -> Void)? = nil, onCreateSkill: (() -> Void)? = nil, connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient? = nil, store: SettingsStore? = nil, conversationManager: ConversationManager? = nil, authManager: AuthManager? = nil, showToast: ((String, ToastInfo.Style) -> Void)? = nil, initialTab: String? = nil, pendingMemoryId: Binding<String?> = .constant(nil), pendingSkillId: Binding<String?> = .constant(nil)) {
        self.onClose = onClose
        self.onInvokeSkill = onInvokeSkill
        self.onCreateSkill = onCreateSkill
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.store = store
        self.conversationManager = conversationManager
        self.authManager = authManager
        self.showToast = showToast
        self.initialTab = initialTab
        _pendingMemoryId = pendingMemoryId
        _pendingSkillId = pendingSkillId
        _selectedTab = State(initialValue: IntelligenceTab(rawValue: initialTab ?? "") ?? .identity)
    }

    private enum IntelligenceTab: String, CaseIterable {
        case identity = "Identity"
        case installedSkills = "Skills"
        case integrations = "Integrations"
        case workspace = "Workspace"
        case contacts = "Contacts"
        case memories = "Memories"
    }

    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        VPageContainer(title: "About \(cachedAssistantName)") {
            // Tab bar
            VTabs(
                items: visibleTabs.map { (label: $0.rawValue, tag: $0) },
                selection: $selectedTab
            )
            .padding(.bottom, VSpacing.md)

            // Tab content
            tabContent
        }
        .onChange(of: pendingMemoryId) {
            if pendingMemoryId != nil {
                withAnimation(VAnimation.fast) { selectedTab = .memories }
            }
        }
        .task {
            let info = await IdentityInfo.loadAsync()
            cachedAssistantName = AssistantDisplayName.resolve(info?.name, fallback: "Your Assistant")
            await loadFeatureFlags()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               let enabled = notification.userInfo?["enabled"] as? Bool {
                if key == Self.emailFeatureFlagKey {
                    isEmailEnabled = enabled
                }
                if key == Self.integrationsFeatureFlagKey {
                    isIntegrationsTabEnabled = enabled
                    if !enabled && selectedTab == .integrations {
                        selectedTab = .identity
                    }
                }
            }
        }
    }

    private var visibleTabs: [IntelligenceTab] {
        IntelligenceTab.allCases.filter { tab in
            if tab == .integrations { return isIntegrationsTabEnabled }
            return true
        }
    }

    private func loadFeatureFlags() async {
        let featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()
        do {
            let flags = try await featureFlagClient.getFeatureFlags()
            if let emailFlag = flags.first(where: { $0.key == Self.emailFeatureFlagKey }) {
                isEmailEnabled = emailFlag.enabled
            }
            if let integrationsFlag = flags.first(where: { $0.key == Self.integrationsFeatureFlagKey }) {
                isIntegrationsTabEnabled = integrationsFlag.enabled
                if !integrationsFlag.enabled && selectedTab == .integrations {
                    selectedTab = .identity
                }
            }
        } catch {
            // Fall through to local file fallback
            let resolved = AssistantFeatureFlagResolver.resolvedFlags(
                registry: loadFeatureFlagRegistry()
            )
            if let emailEnabled = resolved[Self.emailFeatureFlagKey] {
                isEmailEnabled = emailEnabled
            }
            if let integrationsEnabled = resolved[Self.integrationsFeatureFlagKey] {
                isIntegrationsTabEnabled = integrationsEnabled
                if !integrationsEnabled && selectedTab == .integrations {
                    selectedTab = .identity
                }
            }
        }
    }


    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .identity:
            IdentityPanel(
                onClose: onClose,
                connectionManager: connectionManager,
                onNavigateToSkill: { skillId in
                    pendingSkillId = skillId
                    withAnimation(VAnimation.fast) { selectedTab = .installedSkills }
                },
                onNavigateToFile: { path in
                    pendingFilePath = path
                    withAnimation(VAnimation.fast) { selectedTab = .workspace }
                }
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .clipped()

        case .integrations:
            if let store, let authManager {
                IntegrationsPanelContent(
                    store: store,
                    authManager: authManager,
                    showToast: showToast ?? { _, _ in }
                )
                .padding(.top, VSpacing.sm)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                VEmptyState(title: "Integrations are unavailable.")
            }

        case .installedSkills:
            AgentPanelContent(
                onInvokeSkill: onInvokeSkill,
                onCreateSkill: onCreateSkill,
                connectionManager: connectionManager,
                focusedSkillId: $pendingSkillId
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .workspace:
            WorkspacePanel(pendingFilePath: $pendingFilePath)
                .padding(.top, VSpacing.sm)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .contacts:
            ContactsContainerView(
                connectionManager: connectionManager,
                eventStreamClient: eventStreamClient,
                store: store,
                conversationManager: conversationManager,
                isEmailEnabled: isEmailEnabled,
                showToast: showToast
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .memories:
            MemoriesPanel(connectionManager: connectionManager, focusedMemoryId: $pendingMemoryId)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}
