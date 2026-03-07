#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct IntegrationsSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var integrations: [IPCIntegrationListResponseIntegration] = []
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
                                    .foregroundColor(VColor.success)
                                Button("Disconnect") {
                                    disconnectIntegration(integration.id)
                                }
                                .font(.caption)
                                .foregroundColor(VColor.error)
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
        .onDisappear {
            if let daemon = clientProvider.client as? DaemonClient {
                daemon.onIntegrationListResponse = nil
                daemon.onIntegrationConnectResult = nil
            }
        }
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

    private func loadIntegrations() {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        daemon.onIntegrationListResponse = { response in
            integrations = response.integrations
        }
        try? daemon.sendIntegrationList()
    }

    private func connectIntegration(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        connectingIntegrationId = id
        daemon.onIntegrationConnectResult = { result in
            connectingIntegrationId = nil
            if result.success {
                loadIntegrations()
            }
        }
        do {
            try daemon.sendIntegrationConnect(integrationId: id)
        } catch {
            connectingIntegrationId = nil
        }
    }

    private func disconnectIntegration(_ id: String) {
        guard let daemon = clientProvider.client as? DaemonClient else { return }
        try? daemon.sendIntegrationDisconnect(integrationId: id)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            loadIntegrations()
        }
    }
}
#endif
