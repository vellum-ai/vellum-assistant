#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct IntegrationsSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var integrations: [IntegrationListResponseIntegration] = []
    @State private var connectingIntegrationId: String?

    var body: some View {
        Form {
            Section {
                if integrations.isEmpty {
                    Text("No integrations available")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                } else {
                    ForEach(integrations, id: \.id) { integration in
                        HStack {
                            Text(integrationIcon(integration.id))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(integrationDisplayName(integration.id))
                                    .font(.body)
                                if let account = integration.accountInfo {
                                    Text(account)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if connectingIntegrationId == integration.id {
                                ProgressView()
                                    .controlSize(.small)
                            } else if integration.connected {
                                VIconView(.circleCheck, size: 16)
                                    .foregroundColor(VColor.systemPositiveStrong)
                                Button("Disconnect") {
                                    disconnectIntegration(integration.id)
                                }
                                .font(.caption)
                                .foregroundColor(VColor.systemNegativeStrong)
                            } else {
                                Button("Connect") {
                                    connectIntegration(integration.id)
                                }
                                .font(.caption)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Integrations")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { loadIntegrations() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { loadIntegrations() }
        }
        .onDisappear {}
    }

    private func integrationIcon(_ id: String) -> String {
        switch id {
        case "gmail": return "📧"
        default: return "🔗"
        }
    }

    private func integrationDisplayName(_ id: String) -> String {
        switch id {
        case "gmail": return "Gmail"
        default: return id.capitalized
        }
    }

    // Integration registry was removed server-side; these are no-ops.
    private func loadIntegrations() {}
    private func connectIntegration(_ id: String) {}
    private func disconnectIntegration(_ id: String) {}
}
#endif
