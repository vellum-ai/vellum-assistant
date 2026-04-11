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

            Section("Connection Diagnostics") {
                let diag = GatewayHTTPClient.connectionDiagnostics()
                Text(diag)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)

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

            Section("Auth State") {
                let hasToken = SessionTokenManager.getToken() != nil
                let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
                LabeledContent("Session Token", value: hasToken ? "Present" : "Missing")
                    .foregroundStyle(hasToken ? VColor.contentDefault : VColor.systemNegativeStrong)
                LabeledContent("Organization ID", value: orgId ?? "Missing")
                    .foregroundStyle(orgId != nil ? VColor.contentDefault : VColor.systemNegativeStrong)
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
    }
}
#endif
