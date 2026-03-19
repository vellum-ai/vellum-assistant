import SwiftUI
import VellumAssistantShared

/// Card for the Google OAuth service with Managed/Your Own mode toggle.
///
/// Managed mode shows a connect flow for linking Google accounts.
/// Your Own mode shows OAuth app management with connection cards.
/// The mode selection is persisted so user preference is retained.
@MainActor
struct GoogleOAuthServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: ((String, ToastInfo.Style) -> Void)?

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        draftMode != store.googleOAuthMode
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    private var currentUserId: String? {
        authManager.currentUser?.id
    }

    var body: some View {
        ServiceModeCard(
            title: "Google OAuth",
            subtitle: "Configure Google OAuth for Gmail and Calendar access",
            draftMode: $draftMode,
            hasChanges: hasChanges,
            isSaving: false,
            onSave: { save() },
            onReset: nil,
            showReset: false,
            managedContent: {
                managedBody
            },
            yourOwnContent: {
                yourOwnBody
            }
        )
        .onAppear {
            draftMode = store.googleOAuthMode
            if store.googleOAuthMode == "managed" {
                Task { await store.fetchGoogleOAuthConnections(userId: currentUserId) }
            }
        }
        .onChange(of: store.googleOAuthMode) { _, newValue in
            draftMode = newValue
            if newValue == "managed" {
                Task { await store.fetchGoogleOAuthConnections(userId: currentUserId) }
            } else if newValue == "your-own" {
                store.fetchYourOwnOAuthApps()
            }
        }
    }

    // MARK: - Managed Content

    @ViewBuilder
    private var managedBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if !isLoggedIn {
                managedLoginPrompt
            } else if !store.googleOAuthConnections.isEmpty {
                managedConnectionsList
            } else if store.googleOAuthIsConnecting {
                managedConnectingState
            } else {
                VButton(label: "Connect Google Account", style: .primary) {
                    store.startGoogleOAuthConnect(userId: currentUserId)
                }
            }

            if let error = store.googleOAuthError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
    }

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to connect Google.")
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
            VButton(
                label: authManager.isSubmitting ? "Logging in..." : "Log In",
                style: .primary,
                isDisabled: authManager.isSubmitting
            ) {
                Task {
                    if let showToast {
                        await authManager.loginWithToast(showToast: showToast, onSuccess: {
                            Task { await store.fetchGoogleOAuthConnections(userId: currentUserId) }
                        })
                    } else {
                        await authManager.startWorkOSLogin()
                        if authManager.isAuthenticated {
                            await store.fetchGoogleOAuthConnections(userId: currentUserId)
                        }
                    }
                }
            }
        }
    }

    private var managedConnectingState: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            VButton(label: "Connect Google Account", style: .primary, isDisabled: true) {}
            Text("Waiting for authorization...")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    private var managedConnectionsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            ForEach(store.googleOAuthConnections, id: \.id) { entry in
                connectionRow(for: entry)
            }
            VButton(label: "Connect Another Account", style: .outlined, isDisabled: store.googleOAuthIsConnecting) {
                store.startGoogleOAuthConnect(userId: currentUserId)
            }
            if store.googleOAuthIsConnecting {
                Text("Waiting for authorization...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    private func connectionRow(for entry: OAuthConnectionEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.account_label ?? "Google Account")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                if let scopes = entry.scopes_granted, !scopes.isEmpty {
                    Text(scopes.joined(separator: ", "))
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Text("Connected")
                .font(VFont.caption)
                .foregroundColor(VColor.systemPositiveStrong)
            VButton(label: "Disconnect", style: .danger) {
                store.disconnectGoogleOAuthConnection(entry.id, userId: currentUserId)
            }
        }
    }

    // MARK: - Your Own Content

    @ViewBuilder
    private var yourOwnBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if store.yourOwnOAuthIsLoading {
                VBusyIndicator()
            } else if store.yourOwnOAuthApps.isEmpty {
                yourOwnEmptyState
            } else {
                yourOwnAppsList
            }

            if let error = store.yourOwnOAuthError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
        .onAppear {
            store.fetchYourOwnOAuthApps()
        }
    }

    private var yourOwnEmptyState: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("No OAuth apps configured.")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
            Text("Create an OAuth app with your Google Cloud credentials to get started.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    private var yourOwnAppsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            ForEach(store.yourOwnOAuthApps) { app in
                yourOwnAppCard(for: app)
            }
        }
    }

    private func yourOwnAppCard(for app: YourOwnOAuthApp) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Header row: masked client_id + creation date
            HStack {
                Text(maskedClientId(app.client_id))
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                Text(formattedDate(app.created_at))
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }

            // Connections section
            let connections = store.yourOwnOAuthConnectionsByApp[app.id] ?? []
            if connections.isEmpty {
                Text("No connected accounts")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            } else {
                ForEach(connections) { conn in
                    yourOwnConnectionRow(for: conn, appId: app.id)
                }
            }

            // Action row: Log In button
            HStack {
                VButton(
                    label: "Log In",
                    style: .primary,
                    isDisabled: store.yourOwnOAuthConnectingAppId == app.id
                ) {
                    store.startYourOwnOAuthConnect(appId: app.id)
                }
                if store.yourOwnOAuthConnectingAppId == app.id {
                    Text("Waiting for authorization...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    private func yourOwnConnectionRow(for conn: YourOwnOAuthConnection, appId: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(conn.account_info ?? "Google Account")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
            }
            Spacer()
            Text("Connected")
                .font(VFont.caption)
                .foregroundColor(VColor.systemPositiveStrong)
        }
    }

    // MARK: - Helpers

    private func maskedClientId(_ clientId: String) -> String {
        if clientId.count > 8 {
            return String(clientId.prefix(8)) + "..."
        }
        return clientId
    }

    private func formattedDate(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    // MARK: - Save

    private func save() {
        if draftMode != store.googleOAuthMode {
            store.setGoogleOAuthMode(draftMode)
        }
    }
}
