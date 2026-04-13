import SwiftUI
import VellumAssistantShared

// MARK: - Intelligence Panel

struct IntelligencePanel: View {
    var onClose: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onCreateSkill: (() -> Void)?
    var onImportMemory: ((String) -> Void)?
    var onStartConversation: () -> Void
    var onCapabilityCTA: ((Capability) -> Void)?
    var onCapabilityShortcutCTA: ((Capability) -> Void)?
    let connectionManager: GatewayConnectionManager
    let eventStreamClient: EventStreamClient?
    var store: SettingsStore?
    var conversationManager: ConversationManager?
    var authManager: AuthManager?
    var homeStore: HomeStore?
    var assistantFeatureFlagStore: AssistantFeatureFlagStore?
    var showToast: ((String, ToastInfo.Style) -> Void)?
    var initialTab: String? = nil
    @Binding var pendingMemoryId: String?

    @State private var selectedTab: IntelligenceTab
    @State private var cachedAssistantName: String = "Your Assistant"
    @Binding var pendingSkillId: String?
    @State private var pendingFilePath: String?

    init(onClose: @escaping () -> Void, onInvokeSkill: ((SkillInfo) -> Void)? = nil, onCreateSkill: (() -> Void)? = nil, onImportMemory: ((String) -> Void)? = nil, onStartConversation: @escaping () -> Void = {}, onCapabilityCTA: ((Capability) -> Void)? = nil, onCapabilityShortcutCTA: ((Capability) -> Void)? = nil, connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient? = nil, store: SettingsStore? = nil, conversationManager: ConversationManager? = nil, authManager: AuthManager? = nil, homeStore: HomeStore? = nil, assistantFeatureFlagStore: AssistantFeatureFlagStore? = nil, showToast: ((String, ToastInfo.Style) -> Void)? = nil, initialTab: String? = nil, pendingMemoryId: Binding<String?> = .constant(nil), pendingSkillId: Binding<String?> = .constant(nil)) {
        self.onClose = onClose
        self.onInvokeSkill = onInvokeSkill
        self.onCreateSkill = onCreateSkill
        self.onImportMemory = onImportMemory
        self.onStartConversation = onStartConversation
        self.onCapabilityCTA = onCapabilityCTA
        self.onCapabilityShortcutCTA = onCapabilityShortcutCTA
        self.connectionManager = connectionManager
        self.eventStreamClient = eventStreamClient
        self.store = store
        self.conversationManager = conversationManager
        self.authManager = authManager
        self.homeStore = homeStore
        self.assistantFeatureFlagStore = assistantFeatureFlagStore
        self.showToast = showToast
        self.initialTab = initialTab
        _pendingMemoryId = pendingMemoryId
        _pendingSkillId = pendingSkillId
        let homeTabFlagOn = assistantFeatureFlagStore?.isEnabled("home-tab") ?? false
        let defaultTab: IntelligenceTab = homeTabFlagOn ? .home : .identity
        _selectedTab = State(initialValue: IntelligenceTab(rawValue: initialTab ?? "") ?? defaultTab)
    }

    private enum IntelligenceTab: String, CaseIterable {
        case home = "Home"
        case identity = "Identity"
        case installedSkills = "Skills"
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
        .onChange(of: selectedTab) { _, newValue in
            // Clear the sidebar unseen-changes dot as soon as the user
            // navigates onto the Home sub-tab. `.onAppear` on the Home
            // branch covers the first render; this onChange covers every
            // subsequent tab switch back to Home.
            if newValue == .home {
                homeStore?.markSeen()
            }
        }
        .task {
            let info = await IdentityInfo.loadAsync()
            cachedAssistantName = AssistantDisplayName.resolve(info?.name, fallback: "Your Assistant")
        }
    }

    private var visibleTabs: [IntelligenceTab] {
        let flagOn = assistantFeatureFlagStore?.isEnabled("home-tab") ?? false
        return IntelligenceTab.allCases.filter { tab in
            if tab == .home { return flagOn }
            return true
        }
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .home:
            if let homeStore {
                HomePageView(
                    store: homeStore,
                    onStartConversation: onStartConversation,
                    onPrimaryCTA: { capability in onCapabilityCTA?(capability) },
                    onShortcutCTA: { capability in onCapabilityShortcutCTA?(capability) }
                )
                .onAppear {
                    homeStore.isHomeTabVisible = true
                    homeStore.markSeen()
                }
                .onDisappear {
                    homeStore.isHomeTabVisible = false
                }
                .padding(.top, VSpacing.sm)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .clipped()
            } else {
                EmptyView()
            }

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
                },
                onOpenThread: onImportMemory
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .clipped()

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
                showToast: showToast
            )
            .padding(.top, VSpacing.sm)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .memories:
            MemoriesPanel(connectionManager: connectionManager, assistantName: cachedAssistantName, onImportMemory: onImportMemory, focusedMemoryId: $pendingMemoryId)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}
