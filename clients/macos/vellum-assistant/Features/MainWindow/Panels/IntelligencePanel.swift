import SwiftUI
import VellumAssistantShared

// MARK: - Intelligence Panel

struct IntelligencePanel: View {
    var onClose: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    let connectionManager: GatewayConnectionManager
    let eventStreamClient: EventStreamClient?
    var store: SettingsStore?
    var conversationManager: ConversationManager?
    var showToast: ((String, ToastInfo.Style) -> Void)?
    var initialTab: String? = nil
    @Binding var pendingMemoryId: String?

    @State private var selectedTab: IntelligenceTab
    @State private var cachedAssistantName: String = AssistantDisplayName.resolve(IdentityInfo.load()?.name, fallback: "Your Assistant")
    @State private var isContactsEnabled: Bool = false
    @State private var isEmailEnabled: Bool = false
    private static let contactsFeatureFlagKey = "feature_flags.contacts.enabled"
    private static let emailFeatureFlagKey = "feature_flags.email-channel.enabled"

    init(onClose: @escaping () -> Void, onInvokeSkill: ((SkillInfo) -> Void)? = nil, connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient? = nil, store: SettingsStore? = nil, conversationManager: ConversationManager? = nil, showToast: ((String, ToastInfo.Style) -> Void)? = nil, initialTab: String? = nil, pendingMemoryId: Binding<String?> = .constant(nil)) {
        self.onClose = onClose
        self.onInvokeSkill = onInvokeSkill
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.store = store
        self.conversationManager = conversationManager
        self.showToast = showToast
        self.initialTab = initialTab
        _pendingMemoryId = pendingMemoryId
        _selectedTab = State(initialValue: IntelligenceTab(rawValue: initialTab ?? "") ?? .identity)
    }

    private enum IntelligenceTab: String, CaseIterable {
        case identity = "Identity"
        case installedSkills = "Skills"
        case workspace = "Workspace"
        case contacts = "Contacts"
        case memories = "Memories"
    }

    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(alignment: .center) {
                Text("Intelligence")
                    .font(VFont.titleLarge)
                    .foregroundColor(VColor.contentEmphasized)
                Spacer()
            }
            .padding(.bottom, VSpacing.md)

            // Tab bar
            VStack(spacing: 0) {
                HStack(spacing: VSpacing.xl) {
                    ForEach(visibleTabs, id: \.self) { tab in
                        tabButton(tab.rawValue, tab: tab)
                    }
                    Spacer()
                }

                Divider().background(VColor.borderDisabled)
            }
            .padding(.top, VSpacing.md)
            .padding(.bottom, VSpacing.md)

            // Tab content
            tabContent
        }
        .padding(VSpacing.xl)
        .onChange(of: pendingMemoryId) {
            if pendingMemoryId != nil {
                withAnimation(VAnimation.fast) { selectedTab = .memories }
            }
        }
        .task {
            await loadContactsFeatureFlag()
        }
        .onReceive(NotificationCenter.default.publisher(for: .assistantFeatureFlagDidChange)) { notification in
            if let key = notification.userInfo?["key"] as? String,
               let enabled = notification.userInfo?["enabled"] as? Bool {
                if key == Self.contactsFeatureFlagKey {
                    isContactsEnabled = enabled
                    if !enabled && selectedTab == .contacts {
                        selectedTab = .identity
                    }
                } else if key == Self.emailFeatureFlagKey {
                    isEmailEnabled = enabled
                }
            }
        }
    }

    private var visibleTabs: [IntelligenceTab] {
        IntelligenceTab.allCases.filter { tab in
            if tab == .contacts { return isContactsEnabled }
            return true
        }
    }

    private func loadContactsFeatureFlag() async {
        let featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()
        do {
            let flags = try await featureFlagClient.getFeatureFlags()
            if let contactsFlag = flags.first(where: { $0.key == Self.contactsFeatureFlagKey }) {
                isContactsEnabled = contactsFlag.enabled
            }
            if let emailFlag = flags.first(where: { $0.key == Self.emailFeatureFlagKey }) {
                isEmailEnabled = emailFlag.enabled
            }
        } catch {
            // Fall through to local file fallback
            let resolved = AssistantFeatureFlagResolver.resolvedFlags(
                registry: loadFeatureFlagRegistry()
            )
            if let contactsEnabled = resolved[Self.contactsFeatureFlagKey] {
                isContactsEnabled = contactsEnabled
            }
            if let emailEnabled = resolved[Self.emailFeatureFlagKey] {
                isEmailEnabled = emailEnabled
            }
        }
    }

    // MARK: - Tab Button

    @ViewBuilder
    private func tabButton(_ label: String, tab: IntelligenceTab) -> some View {
        let isActive = selectedTab == tab
        Button {
            withAnimation(VAnimation.fast) { selectedTab = tab }
        } label: {
            VStack(spacing: VSpacing.sm) {
                Text(label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundColor(isActive ? VColor.primaryActive : VColor.contentSecondary)
                    .padding(.bottom, VSpacing.xs)

                Rectangle()
                    .fill(isActive ? VColor.borderActive : Color.clear)
                    .frame(height: 2)
            }
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .identity:
            IdentityPanel(
                onClose: onClose,
                connectionManager: connectionManager
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .clipped()

        case .installedSkills:
            AgentPanelContent(
                onInvokeSkill: onInvokeSkill,
                connectionManager: connectionManager
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .workspace:
            WorkspacePanel(connectionManager: connectionManager)
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
