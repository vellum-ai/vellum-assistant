#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Developer settings section, accessible only when developer mode is enabled.
///
/// Contains the debug panel entry point and diagnostic utilities. Exposed via
/// a NavigationLink in SettingsView after developer mode is unlocked by tapping
/// the version label 7 times.
struct DeveloperSettingsSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @ObservedObject var conversationStore: IOSConversationStore

    var body: some View {
        // Forward clientProvider.traceStore into a child view that holds it as
        // @ObservedObject so SwiftUI re-renders when trace events arrive
        // (keeps counts and the Clear button's enabled state live).
        DeveloperSettingsSectionContent(
            clientProvider: clientProvider,
            traceStore: clientProvider.traceStore,
            conversationStore: conversationStore
        )
    }
}

private struct DeveloperSettingsSectionContent: View {
    let clientProvider: ClientProvider
    @ObservedObject var traceStore: TraceStore
    @ObservedObject var conversationStore: IOSConversationStore
    @State private var showDebugPanel = false
    @State private var showUsageDashboard = false
    // Captured once when the sheet opens so the panel stays on the same conversation
    // even if newer trace events arrive while the sheet is visible.
    @State private var selectedConversationId: String?
    // Preserved across sheet presentations to avoid redundant network calls
    // and loading spinners each time the usage dashboard is opened.
    // Updated via .onChange(of: clientGeneration) when rebuildClient() fires.
    @State private var usageDashboardStore: UsageDashboardStore

    // Assistant picker state
    @State private var availableAssistants: [PlatformAssistant] = []
    @State private var selectedAssistantId: String = ""
    @State private var isLoadingAssistants = false
    @State private var assistantLoadError: String?
    @State private var showResetConfirmation = false

    init(clientProvider: ClientProvider, traceStore: TraceStore, conversationStore: IOSConversationStore) {
        self.clientProvider = clientProvider
        self.traceStore = traceStore
        self.conversationStore = conversationStore
        _usageDashboardStore = State(initialValue: UsageDashboardStore())
    }

    private var conversationCount: Int {
        traceStore.eventsByConversation.count
    }

    private var totalEventCount: Int {
        traceStore.eventsByConversation.values.reduce(0) { $0 + $1.count }
    }

    var body: some View {
        Form {
            assistantSection

            Section("Trace Store") {
                LabeledContent("Conversations with events", value: "\(conversationCount)")
                LabeledContent("Total events", value: "\(totalEventCount)")

                Button("Clear All Trace Events", role: .destructive) {
                    traceStore.resetAll()
                }
                .disabled(totalEventCount == 0)
            }

            Section("Debug Panel") {
                Button {
                    // Snapshot the most recent conversation at open time so the panel
                    // doesn't jump to a different conversation if newer events arrive.
                    selectedConversationId = traceStore.mostRecentConversationId
                    showDebugPanel = true
                } label: {
                    Label { Text("Open Debug Panel") } icon: { VIconView(.bug, size: 14) }
                }
            }

            Section("Usage & Cost") {
                Button {
                    showUsageDashboard = true
                } label: {
                    Label { Text("Usage Dashboard") } icon: { VIconView(.barChart, size: 14) }
                }
            }

            Section("Connection") {
                LabeledContent("Status", value: clientProvider.isConnected ? "Connected" : "Disconnected")
            }

            Section {
                Button("Reset Connection & Re-onboard", role: .destructive) {
                    showResetConfirmation = true
                }
            } header: {
                Text("Reset")
            } footer: {
                Text("Clears all connection state (tokens, assistant config, org ID) and returns to the onboarding flow. Preferences like appearance and voice settings are preserved.")
            }

            Section("Connection Diagnostics") {
                let diag = GatewayHTTPClient.connectionDiagnostics()
                Text(diag)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)

                // Detailed prerequisite breakdown so the developer can see
                // exactly which piece is present vs missing.
                let hasSessionToken = SessionTokenManager.getToken() != nil
                let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
                let managedId = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedAssistantId)
                let managedURL = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedPlatformBaseURL)
                let gatewayURL = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL)

                LabeledContent("Session Token", value: hasSessionToken ? "Present" : "Missing")
                    .foregroundStyle(hasSessionToken ? VColor.contentDefault : VColor.systemNegativeStrong)
                LabeledContent("Organization ID", value: orgId ?? "Missing")
                    .foregroundStyle(orgId != nil ? VColor.contentDefault : VColor.systemNegativeStrong)
                LabeledContent("Managed Assistant ID", value: managedId ?? "Missing")
                    .foregroundStyle(managedId != nil ? VColor.contentDefault : VColor.systemNegativeStrong)
                LabeledContent("Managed Platform URL", value: managedURL ?? "Missing")
                    .foregroundStyle(managedURL != nil ? VColor.contentDefault : VColor.systemNegativeStrong)
                LabeledContent("Gateway Base URL", value: gatewayURL ?? "Missing")
                    .foregroundStyle(gatewayURL != nil ? VColor.contentDefault : VColor.systemNegativeStrong)
                LabeledContent("Resolved Platform URL", value: VellumEnvironment.resolvedPlatformURL)
                LabeledContent("Environment", value: "\(VellumEnvironment.current)")

                if let fetchError = conversationStore.lastFetchError {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Last Fetch Error")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.systemNegativeStrong)
                        Text(fetchError)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(VColor.systemNegativeStrong)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .navigationTitle("Developer")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showDebugPanel) {
            DebugPanelView(
                traceStore: traceStore,
                conversationId: selectedConversationId,
                onClose: { showDebugPanel = false }
            )
        }
        .sheet(isPresented: $showUsageDashboard) {
            UsageDashboardView(store: usageDashboardStore)
        }
        .onChange(of: clientProvider.clientGeneration) {
            usageDashboardStore.reset()
        }
        .alert("Reset Connection?", isPresented: $showResetConfirmation) {
            Button("Reset & Re-onboard", role: .destructive) {
                performConnectionReset()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will clear all connection credentials and return to onboarding. You will need to log in or pair again.")
        }
        .task {
            await loadAssistants()
        }
    }

    // MARK: - Assistant Picker

    @ViewBuilder
    private var assistantSection: some View {
        if isLoadingAssistants {
            Section("Assistant") {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading assistants…")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
        } else if let error = assistantLoadError {
            Section("Assistant") {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                Button("Retry") {
                    Task { await loadAssistants() }
                }
            }
        } else if availableAssistants.count > 1 {
            Section("Assistant") {
                Picker("Active Assistant", selection: $selectedAssistantId) {
                    ForEach(availableAssistants, id: \.id) { assistant in
                        Text(assistant.name ?? assistant.id)
                            .tag(assistant.id)
                    }
                }
                .onChange(of: selectedAssistantId) { _, newId in
                    switchAssistant(to: newId)
                }

                if let active = availableAssistants.first(where: { $0.id == selectedAssistantId }) {
                    assistantDetailRows(active)
                }
            }
        } else if let sole = availableAssistants.first {
            Section("Assistant") {
                LabeledContent("Name", value: sole.name ?? sole.id)
                assistantDetailRows(sole)
            }
        }
    }

    @ViewBuilder
    private func assistantDetailRows(_ assistant: PlatformAssistant) -> some View {
        LabeledContent("ID", value: assistant.id)
            .font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
        if let status = assistant.status {
            LabeledContent("Status", value: status)
        }
    }

    private func loadAssistants() async {
        guard let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"),
              !orgId.isEmpty else {
            return
        }

        isLoadingAssistants = true
        assistantLoadError = nil

        do {
            let assistants = try await AuthService.shared.listAssistants(organizationId: orgId)
            availableAssistants = assistants
            let currentId = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedAssistantId) ?? ""
            if assistants.contains(where: { $0.id == currentId }) {
                selectedAssistantId = currentId
            } else if let first = assistants.first {
                selectedAssistantId = first.id
                switchAssistant(to: first.id)
            }
        } catch is CancellationError {
            // .task cancelled during navigation — not a user-visible error
        } catch {
            assistantLoadError = error.localizedDescription
        }

        isLoadingAssistants = false
    }

    // MARK: - Connection Reset

    private func performConnectionReset() {
        let defaults = UserDefaults.standard

        // Clear managed assistant config
        defaults.removeObject(forKey: UserDefaultsKeys.managedAssistantId)
        defaults.removeObject(forKey: UserDefaultsKeys.managedPlatformBaseURL)

        // Clear QR-paired gateway config
        defaults.removeObject(forKey: UserDefaultsKeys.gatewayBaseURL)

        // Clear organization ID
        defaults.removeObject(forKey: "connectedOrganizationId")

        // Clear keychain credentials
        SessionTokenManager.deleteToken()
        ActorTokenManager.deleteAllCredentials()
        _ = APIKeyManager.shared.deleteAPIKey(provider: "runtime-bearer-token")

        // Rebuild the client so it picks up the cleared state
        clientProvider.rebuildClient()

        // Return to onboarding by resetting the completion flag.
        // VellumAssistantApp observes this via @AppStorage and will
        // swap ContentView for OnboardingView.
        defaults.set(false, forKey: "onboarding_completed")
    }

    private func switchAssistant(to assistantId: String) {
        let currentId = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedAssistantId) ?? ""
        guard assistantId != currentId, !assistantId.isEmpty else { return }

        UserDefaults.standard.set(assistantId, forKey: UserDefaultsKeys.managedAssistantId)
        clientProvider.rebuildClient()
    }
}
#endif
