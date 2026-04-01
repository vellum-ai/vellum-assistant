import SwiftUI
import VellumAssistantShared

/// Modal presented when a user taps an integration card in the grid.
/// Shows provider info, connected accounts, and connect/disconnect actions.
@MainActor
struct IntegrationDetailModal: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: (String, ToastInfo.Style) -> Void
    let providerKey: String
    let onClose: () -> Void

    @State private var showDisconnectAlert = false
    @State private var connectionToDisconnect: OAuthConnectionEntry? = nil

    private var providerMeta: OAuthProviderMetadata? {
        store.managedOAuthProviders.first { $0.provider_key == providerKey }
    }

    private var displayName: String {
        providerMeta?.display_name ?? providerKey
    }

    private var providerDescription: String? {
        providerMeta?.description
    }

    private var connections: [OAuthConnectionEntry] {
        store.managedConnections(for: providerKey)
    }

    private var isConnecting: Bool {
        store.managedIsConnecting(for: providerKey)
    }

    private var errorMessage: String? {
        store.managedError(for: providerKey)
    }

    private var currentUserId: String? {
        authManager.currentUser?.id
    }

    var body: some View {
        VModal(
            title: displayName,
            subtitle: providerDescription,
            closeAction: onClose
        ) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Provider icon and connection status
                HStack(spacing: VSpacing.md) {
                    IntegrationIcon.image(for: providerKey, size: 32)
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(displayName)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentDefault)
                        if connections.isEmpty {
                            Text("Not connected")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        } else {
                            Text("\(connections.count) account\(connections.count == 1 ? "" : "s") connected")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.systemPositiveStrong)
                        }
                    }
                }

                // Error message
                if let errorMessage {
                    VInlineMessage(errorMessage, tone: .error)
                }

                // Connecting state
                if isConnecting {
                    HStack(spacing: VSpacing.sm) {
                        VBusyIndicator(size: 8, color: VColor.contentTertiary)
                        Text("Waiting for authorization...")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }

                // Connected accounts list
                if !connections.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Connected Accounts")
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentSecondary)

                        ForEach(connections, id: \.id) { entry in
                            connectionRow(for: entry)
                        }
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined, action: onClose)
                VButton(
                    label: connections.isEmpty ? "Connect" : "Connect Another Account",
                    leftIcon: connections.isEmpty ? nil : "lucide-plus",
                    style: .primary,
                    isDisabled: isConnecting
                ) {
                    store.startManagedOAuthConnect(providerKey: providerKey, userId: currentUserId)
                }
            }
        }
        .frame(width: 480)
        .onAppear {
            Task {
                await store.fetchManagedOAuthConnections(providerKey: providerKey, userId: currentUserId)
            }
        }
        .alert("Disconnect Account?", isPresented: $showDisconnectAlert) {
            Button("Cancel", role: .cancel) {
                connectionToDisconnect = nil
            }
            Button("Disconnect", role: .destructive) {
                if let connection = connectionToDisconnect {
                    store.disconnectManagedOAuthConnection(connection.id, providerKey: providerKey, userId: currentUserId)
                    showToast("Account disconnected", .success)
                    connectionToDisconnect = nil
                }
            }
        } message: {
            if let connection = connectionToDisconnect {
                Text("Disconnect \"\(connection.account_label ?? "\(displayName) Account")\"? You can reconnect later.")
            }
        }
    }

    // MARK: - Connection Row

    private func connectionRow(for entry: OAuthConnectionEntry) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.circleUser, size: 14)
                .foregroundStyle(VColor.contentSecondary)

            Text(entry.account_label ?? "\(displayName) Account")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)

            Spacer()

            VTag("Connected", color: VColor.systemPositiveStrong, icon: .circleCheck)

            VButton(label: "Disconnect", style: .dangerOutline, size: .compact) {
                connectionToDisconnect = entry
                showDisconnectAlert = true
            }
        }
        .padding(.vertical, VSpacing.xs)
        .padding(.horizontal, VSpacing.sm)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}
