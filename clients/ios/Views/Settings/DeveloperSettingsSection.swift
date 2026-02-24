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

    var body: some View {
        // Forward clientProvider.traceStore into a child view that holds it as
        // @ObservedObject so SwiftUI re-renders when trace events arrive
        // (keeps counts and the Clear button's enabled state live).
        DeveloperSettingsSectionContent(
            clientProvider: clientProvider,
            traceStore: clientProvider.traceStore
        )
    }
}

private struct DeveloperSettingsSectionContent: View {
    let clientProvider: ClientProvider
    @ObservedObject var traceStore: TraceStore
    @State private var showDebugPanel = false

    private var sessionCount: Int {
        traceStore.eventsBySession.count
    }

    private var totalEventCount: Int {
        traceStore.eventsBySession.values.reduce(0) { $0 + $1.count }
    }

    var body: some View {
        Form {
            Section("Trace Store") {
                LabeledContent("Sessions with events", value: "\(sessionCount)")
                LabeledContent("Total events", value: "\(totalEventCount)")

                Button("Clear All Trace Events", role: .destructive) {
                    traceStore.resetAll()
                }
                .disabled(totalEventCount == 0)
            }

            Section("Debug Panel") {
                Button {
                    showDebugPanel = true
                } label: {
                    Label("Open Debug Panel", systemImage: "ladybug")
                }
            }

            Section("Connection") {
                LabeledContent("Status", value: clientProvider.isConnected ? "Connected" : "Disconnected")
            }
        }
        .navigationTitle("Developer")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showDebugPanel) {
            // Use the most recently active session rather than an arbitrary dict key.
            let sessionId = traceStore.mostRecentSessionId
            DebugPanelView(
                traceStore: traceStore,
                sessionId: sessionId,
                onClose: { showDebugPanel = false }
            )
        }
    }
}

#Preview {
    NavigationStack {
        DeveloperSettingsSection()
            .environmentObject(ClientProvider(client: DaemonClient(config: .fromUserDefaults())))
    }
}
#endif
