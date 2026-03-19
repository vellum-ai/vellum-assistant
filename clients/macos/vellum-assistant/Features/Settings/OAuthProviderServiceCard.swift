import SwiftUI
import VellumAssistantShared

/// Generic card for an OAuth provider service with Managed/Your Own mode toggle.
///
/// Managed mode shows a connect flow for linking accounts via platform OAuth.
/// Your Own mode shows OAuth app management with connection cards.
/// The mode selection is persisted so user preference is retained.
@MainActor
struct OAuthProviderServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: (String, ToastInfo.Style) -> Void
    let providerKey: String

    // MARK: - Metadata Helpers

    private var providerMeta: OAuthProviderMetadata? {
        store.yourOwnProviderMeta(for: providerKey)
    }

    private var displayName: String {
        providerMeta?.display_name ?? "OAuth"
    }

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"

    // MARK: - Create App Sheet State

    @State private var showCreateAppSheet = false
    @State private var createAppClientId = ""
    @State private var createAppClientSecret = ""
    @State private var createAppIsSubmitting = false

    // MARK: - Delete App Alert State

    @State private var showDeleteAppAlert = false
    @State private var appToDelete: YourOwnOAuthApp? = nil

    // MARK: - Disconnect Alert State

    @State private var showDisconnectAlert = false
    @State private var disconnectConnection: YourOwnOAuthConnection? = nil
    @State private var disconnectAppId: String? = nil

    // MARK: - Hover Tracking

    @State private var hoveredAppId: String? = nil

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        draftMode != store.managedOAuthModeFor(providerKey)
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    private var currentUserId: String? {
        authManager.currentUser?.id
    }

    var body: some View {
        ServiceModeCard(
            title: "\(displayName) OAuth",
            subtitle: "Configure \(displayName) OAuth\(providerMeta?.description.map { " for \($0)" } ?? "")",
            draftMode: $draftMode,
            hasChanges: hasChanges,
            isSaving: false,
            onSave: { save() },
            onReset: nil,
            showReset: false,
            hideButtons: draftMode == "managed" && !isLoggedIn,
            managedContent: {
                managedBody
            },
            yourOwnContent: {
                yourOwnBody
            }
        )
        .onAppear {
            draftMode = store.managedOAuthModeFor(providerKey)
            // Always fetch provider metadata (for display name etc.) regardless of mode
            store.fetchYourOwnOAuthApps(providerKey: providerKey)
            if store.managedOAuthModeFor(providerKey) == "managed" {
                Task { await store.fetchManagedOAuthConnections(providerKey: providerKey, userId: currentUserId) }
            }
        }
        .onChange(of: store.managedOAuthModeFor(providerKey)) { _, newValue in
            draftMode = newValue
            if newValue == "managed" {
                Task { await store.fetchManagedOAuthConnections(providerKey: providerKey, userId: currentUserId) }
            } else if newValue == "your-own" {
                store.fetchYourOwnOAuthApps(providerKey: providerKey)
            }
        }
        .sheet(isPresented: $showCreateAppSheet) {
            createAppSheet
        }
        .alert("Delete OAuth App?", isPresented: $showDeleteAppAlert) {
            Button("Cancel", role: .cancel) { appToDelete = nil }
            Button("Delete", role: .destructive) {
                if let app = appToDelete {
                    Task { await store.deleteYourOwnOAuthApp(id: app.id, providerKey: providerKey) }
                    appToDelete = nil
                }
            }
        } message: {
            if let app = appToDelete {
                Text("This will disconnect all accounts and remove the app with client ID '\(maskedClientId(app.client_id))'.")
            }
        }
        .alert("Disconnect Account?", isPresented: $showDisconnectAlert) {
            Button("Cancel", role: .cancel) {
                disconnectConnection = nil
                disconnectAppId = nil
            }
            Button("Disconnect", role: .destructive) {
                if let conn = disconnectConnection, let appId = disconnectAppId {
                    Task { await store.disconnectYourOwnOAuthConnection(id: conn.id, appId: appId) }
                    disconnectConnection = nil
                    disconnectAppId = nil
                }
            }
        } message: {
            if let conn = disconnectConnection {
                Text("Disconnect '\(conn.account_info ?? "\(displayName) Account")'? You can reconnect later.")
            }
        }
    }

    // MARK: - Managed Content

    @ViewBuilder
    private var managedBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if !isLoggedIn {
                managedLoginPrompt
            } else if !store.managedConnections(for: providerKey).isEmpty {
                managedConnectionsList
            } else if store.managedIsConnecting(for: providerKey) {
                managedConnectingState
            } else {
                VButton(label: "Connect \(displayName) Account", style: .primary) {
                    store.startManagedOAuthConnect(providerKey: providerKey, userId: currentUserId)
                }
            }

            if let error = store.managedError(for: providerKey) {
                VInlineMessage(error, tone: .error)
            }
        }
    }

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to connect \(displayName).")
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
            VButton(
                label: authManager.isSubmitting ? "Logging in..." : "Log In",
                style: .primary,
                isDisabled: authManager.isSubmitting
            ) {
                Task {
                    await authManager.loginWithToast(showToast: showToast, onSuccess: {
                        Task { await store.fetchManagedOAuthConnections(providerKey: providerKey, userId: currentUserId) }
                    })
                }
            }
        }
    }

    private var managedConnectingState: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            VButton(label: "Connect \(displayName) Account", style: .primary, isDisabled: true) {}
            Text("Waiting for authorization...")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    private var managedConnectionsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            ForEach(store.managedConnections(for: providerKey), id: \.id) { entry in
                managedConnectionRow(for: entry)
            }
            VButton(label: "Connect Another Account", style: .outlined, isDisabled: store.managedIsConnecting(for: providerKey)) {
                store.startManagedOAuthConnect(providerKey: providerKey, userId: currentUserId)
            }
            if store.managedIsConnecting(for: providerKey) {
                Text("Waiting for authorization...")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    private func managedConnectionRow(for entry: OAuthConnectionEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.account_label ?? "\(displayName) Account")
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
                store.disconnectManagedOAuthConnection(entry.id, providerKey: providerKey, userId: currentUserId)
            }
        }
    }

    // MARK: - Your Own Content

    @ViewBuilder
    private var yourOwnBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if store.yourOwnIsLoading(for: providerKey) {
                HStack {
                    Spacer()
                    VBusyIndicator()
                    Spacer()
                }
                .padding(.vertical, VSpacing.lg)
            } else if store.yourOwnApps(for: providerKey).isEmpty {
                yourOwnEmptyState
            } else {
                yourOwnAppsList
            }

            if let error = store.yourOwnError(for: providerKey) {
                VInlineMessage(error, tone: .error)
            }
        }
        .onAppear {
            store.fetchYourOwnOAuthApps(providerKey: providerKey)
        }
    }

    private var yourOwnEmptyState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.keyRound, size: 32)
                .foregroundColor(VColor.contentTertiary)

            VStack(spacing: VSpacing.xs) {
                Text("No OAuth apps configured")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                Text("Add your \(displayName) OAuth credentials to connect accounts.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
            }

            VButton(label: "Add OAuth App", leftIcon: "lucide-plus", style: .primary) {
                createAppClientId = ""
                createAppClientSecret = ""
                showCreateAppSheet = true
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    private var yourOwnAppsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            ForEach(store.yourOwnApps(for: providerKey)) { app in
                yourOwnAppCard(for: app)
            }

            VButton(label: "Add OAuth App", leftIcon: "lucide-plus", style: .outlined) {
                createAppClientId = ""
                createAppClientSecret = ""
                showCreateAppSheet = true
            }
        }
    }

    private func yourOwnAppCard(for app: YourOwnOAuthApp) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Header: key icon + masked client_id + date + trash
            HStack(spacing: VSpacing.sm) {
                VIconView(.keyRound, size: 14)
                    .foregroundColor(VColor.contentTertiary)

                Text(maskedClientId(app.client_id))
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                Spacer()

                Text(formattedDate(app.created_at))
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)

                if hoveredAppId == app.id {
                    Button {
                        appToDelete = app
                        showDeleteAppAlert = true
                    } label: {
                        VIconView(.trash, size: 14)
                            .foregroundColor(VColor.systemNegativeStrong)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Delete OAuth App")
                    .transition(.opacity.animation(VAnimation.fast))
                }
            }

            Divider()
                .foregroundColor(VColor.borderBase)

            // Connections
            let connections = store.yourOwnOAuthConnectionsByApp[app.id] ?? []
            if connections.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleUser, size: 14)
                        .foregroundColor(VColor.contentTertiary)
                    Text("No connected accounts")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                .padding(.vertical, VSpacing.xxs)
            } else {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(connections) { conn in
                        yourOwnConnectionRow(for: conn, appId: app.id)
                    }
                }
            }

            // Connect button
            HStack(spacing: VSpacing.sm) {
                if store.yourOwnOAuthConnectingAppId == app.id {
                    VButton(label: "Cancel", leftIcon: "lucide-x", style: .outlined) {
                        store.cancelYourOwnOAuthConnect()
                    }
                    VBusyIndicator(size: 8, color: VColor.contentTertiary)
                    Text("Waiting for authorization...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                } else {
                    VButton(
                        label: "Connect Account",
                        leftIcon: "lucide-external-link",
                        style: .outlined,
                        isDisabled: store.yourOwnOAuthConnectingAppId != nil
                    ) {
                        store.startYourOwnOAuthConnect(appId: app.id)
                    }
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
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredAppId = hovering ? app.id : nil
            }
        }
    }

    private func yourOwnConnectionRow(for conn: YourOwnOAuthConnection, appId: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.circleUser, size: 14)
                .foregroundColor(VColor.contentSecondary)

            Text(conn.account_info ?? "\(displayName) Account")
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)

            Spacer()

            VBadge(label: "Connected", icon: .circleCheck, tone: .positive, emphasis: .subtle)

            VButton(label: "Disconnect", style: .danger, size: .compact) {
                disconnectConnection = conn
                disconnectAppId = appId
                showDisconnectAlert = true
            }
        }
        .padding(.vertical, VSpacing.xxs)
    }

    // MARK: - Create App Sheet

    private var createAppSheet: some View {
        VModal(
            title: "Add OAuth App",
            subtitle: "Enter your \(displayName) OAuth credentials",
            closeAction: { showCreateAppSheet = false }
        ) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Client ID")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                    VTextField(placeholder: providerMeta?.client_id_placeholder ?? "Enter client ID", text: $createAppClientId)
                }
                if (providerMeta?.requires_client_secret ?? 1) != 0 {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("Client Secret")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentSecondary)
                        SecureField("Enter client secret", text: $createAppClientSecret)
                            .vInputStyle()
                            .font(VFont.body)
                    }
                }
                if providerMeta?.dashboard_url != nil {
                    VInlineMessage("Find these in your \(displayName) developer console.", tone: .info)
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    showCreateAppSheet = false
                }
                VButton(
                    label: createAppIsSubmitting ? "Creating..." : "Create",
                    style: .primary,
                    isDisabled: createAppClientId.isEmpty || ((providerMeta?.requires_client_secret ?? 1) != 0 && createAppClientSecret.isEmpty) || createAppIsSubmitting
                ) {
                    createAppIsSubmitting = true
                    Task {
                        await store.createYourOwnOAuthApp(providerKey: providerKey, clientId: createAppClientId, clientSecret: createAppClientSecret)
                        createAppIsSubmitting = false
                        showCreateAppSheet = false
                    }
                }
            }
        }
        .frame(width: 440)
    }

    // MARK: - Helpers

    private func maskedClientId(_ clientId: String) -> String {
        if clientId.count > 16 {
            return String(clientId.prefix(12)) + "..." + String(clientId.suffix(4))
        } else if clientId.count > 8 {
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
        if draftMode != store.managedOAuthModeFor(providerKey) {
            store.setManagedOAuthMode(draftMode, providerKey: providerKey)
        }
    }
}
