import SwiftUI
import VellumAssistantShared

/// Modal presented when a user taps an integration card in the grid.
/// Shows provider info with Managed/Your Own tabs, preserving the same
/// connect/disconnect experience as the full-page service cards.
@MainActor
struct IntegrationDetailModal: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    var showToast: (String, ToastInfo.Style) -> Void
    let providerKey: String
    let onClose: () -> Void

    @State private var draftMode: String = "your-own"

    // MARK: - Managed Disconnect State

    @State private var showDisconnectAlert = false
    @State private var connectionToDisconnect: OAuthConnectionEntry? = nil

    // MARK: - Your Own State

    @State private var createAppClientId = ""
    @State private var createAppClientSecret = ""
    @State private var createAppIsSubmitting = false

    @State private var showDeleteAppAlert = false
    @State private var appToDelete: YourOwnOAuthApp? = nil

    @State private var showYourOwnDisconnectAlert = false
    @State private var yourOwnDisconnectConnection: YourOwnOAuthConnection? = nil
    @State private var yourOwnDisconnectAppId: String? = nil

    @State private var hoveredAppId: String? = nil

    // MARK: - Computed Properties

    private var providerMeta: OAuthProviderMetadata? {
        store.managedOAuthProviders.first { $0.provider_key == providerKey }
    }

    private var yourOwnMeta: OAuthProviderMetadata? {
        store.yourOwnProviderMeta(for: providerKey)
    }

    private var displayName: String {
        providerMeta?.display_name ?? yourOwnMeta?.display_name ?? providerKey.capitalized
    }

    private var connections: [OAuthConnectionEntry] {
        store.managedConnections(for: providerKey)
    }

    private var isConnecting: Bool {
        store.managedIsConnecting(for: providerKey)
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    private var currentUserId: String? {
        authManager.currentUser?.id
    }

    // MARK: - Body

    var body: some View {
        VModal(
            title: "\(displayName) OAuth",
            subtitle: providerMeta?.description.map { "Configure \(displayName) OAuth for \($0)" }
                ?? "Configure \(displayName) OAuth",
            closeAction: onClose
        ) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Mode tabs
                VTabs(
                    items: [
                        (label: "Managed", tag: "managed"),
                        (label: "Your Own", tag: "your-own"),
                    ],
                    selection: $draftMode,
                    style: .pill
                )
                .frame(maxWidth: .infinity)

                // Mode-specific content
                if draftMode == "managed" {
                    managedBody
                } else {
                    yourOwnBody
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Close", style: .outlined, action: onClose)
                if draftMode == "managed" {
                    managedFooterButton
                } else {
                    yourOwnFooterButton
                }
            }
        }
        .frame(width: 520)
        .onAppear {
            draftMode = store.managedOAuthModeFor(providerKey)
            store.fetchYourOwnOAuthApps(providerKey: providerKey)
            if store.managedOAuthModeFor(providerKey) == "managed" {
                Task { await store.fetchManagedOAuthConnections(providerKey: providerKey, userId: currentUserId) }
            }
        }
        .onChange(of: draftMode) { _, newMode in
            if newMode != store.managedOAuthModeFor(providerKey) {
                store.setManagedOAuthMode(newMode, providerKey: providerKey)
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
        .alert("Disconnect Account?", isPresented: $showDisconnectAlert) {
            Button("Cancel", role: .cancel) { connectionToDisconnect = nil }
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
        .alert("Disconnect Account?", isPresented: $showYourOwnDisconnectAlert) {
            Button("Cancel", role: .cancel) {
                yourOwnDisconnectConnection = nil
                yourOwnDisconnectAppId = nil
            }
            Button("Disconnect", role: .destructive) {
                if let conn = yourOwnDisconnectConnection, let appId = yourOwnDisconnectAppId {
                    Task { await store.disconnectYourOwnOAuthConnection(id: conn.id, appId: appId) }
                    yourOwnDisconnectConnection = nil
                    yourOwnDisconnectAppId = nil
                }
            }
        } message: {
            if let conn = yourOwnDisconnectConnection {
                Text("Disconnect '\(conn.account_info ?? "\(displayName) Account")'? You can reconnect later.")
            }
        }
    }

    // MARK: - Managed Tab

    @ViewBuilder
    private var managedBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if !isLoggedIn {
                managedLoginPrompt
            } else if !connections.isEmpty {
                managedConnectionsList
            } else if isConnecting {
                managedConnectingState
            } else {
                Text("No accounts connected yet.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            }

            if let error = store.managedError(for: providerKey) {
                VInlineMessage(error, tone: .error)
            }
        }
    }

    @ViewBuilder
    private var managedFooterButton: some View {
        if isLoggedIn && !isConnecting {
            VButton(
                label: connections.isEmpty ? "Connect" : "Connect Another Account",
                leftIcon: connections.isEmpty ? nil : "lucide-plus",
                style: .primary
            ) {
                store.startManagedOAuthConnect(providerKey: providerKey, userId: currentUserId)
            }
        } else if isConnecting {
            HStack(spacing: VSpacing.sm) {
                VBusyIndicator(size: 8, color: VColor.contentTertiary)
                Text("Waiting for authorization...")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to connect \(displayName).")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
            VButton(
                label: authManager.isSubmitting ? "Logging in..." : "Log In",
                style: .primary,
                isDisabled: authManager.isSubmitting
            ) {
                Task {
                    await authManager.loginWithToast(showToast: showToast, onSuccess: {
                        if AppDelegate.shared?.isCurrentAssistantManaged ?? false {
                            AppDelegate.shared?.reconnectManagedAssistant()
                        }
                        Task { await store.fetchManagedOAuthConnections(providerKey: providerKey, userId: currentUserId) }
                    })
                }
            }
        }
    }

    private var managedConnectingState: some View {
        HStack(spacing: VSpacing.sm) {
            VBusyIndicator(size: 8, color: VColor.contentTertiary)
            Text("Waiting for authorization...")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    private var managedConnectionsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Connected Accounts")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentSecondary)

            ForEach(connections, id: \.id) { entry in
                managedConnectionRow(for: entry)
            }
        }
    }

    private func managedConnectionRow(for entry: OAuthConnectionEntry) -> some View {
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

    // MARK: - Your Own Tab

    @ViewBuilder
    private var yourOwnBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if store.yourOwnIsLoading(for: providerKey) {
                yourOwnSkeleton
            } else {
                // Always show credential fields
                VTextField(
                    "Client ID",
                    placeholder: yourOwnMeta?.client_id_placeholder ?? "Enter client ID",
                    text: $createAppClientId
                )
                if yourOwnMeta?.requires_client_secret ?? true {
                    VTextField(
                        "Client Secret",
                        placeholder: "Enter client secret",
                        text: $createAppClientSecret,
                        isSecure: true
                    )
                }
                if yourOwnMeta?.dashboard_url != nil {
                    VInlineMessage("Find these in your \(displayName) developer console.", tone: .info)
                }

                // Existing apps and their connections
                if !store.yourOwnApps(for: providerKey).isEmpty {
                    Divider().foregroundStyle(VColor.borderBase)

                    ForEach(store.yourOwnApps(for: providerKey)) { app in
                        yourOwnAppCard(for: app)
                    }
                }
            }

            if let error = store.yourOwnError(for: providerKey) {
                VInlineMessage(error, tone: .error)
            }
        }
        .onAppear {
            store.fetchYourOwnOAuthApps(providerKey: providerKey)
            // Pre-fill fields from existing app if there is one
            if let existingApp = store.yourOwnApps(for: providerKey).first {
                createAppClientId = existingApp.client_id
                createAppClientSecret = ""
            }
        }
    }

    private var yourOwnSkeleton: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VSkeletonBone(width: 80, height: 12)
                VSkeletonBone(height: 36, radius: VRadius.md)
            }
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VSkeletonBone(width: 100, height: 12)
                VSkeletonBone(height: 36, radius: VRadius.md)
            }
        }
    }

    @ViewBuilder
    private var yourOwnFooterButton: some View {
        VButton(
            label: createAppIsSubmitting ? "Saving..." : "Save",
            style: .primary,
            isDisabled: createAppClientId.isEmpty || ((yourOwnMeta?.requires_client_secret ?? true) && createAppClientSecret.isEmpty) || createAppIsSubmitting
        ) {
            createAppIsSubmitting = true
            Task {
                await store.createYourOwnOAuthApp(providerKey: providerKey, clientId: createAppClientId, clientSecret: createAppClientSecret)
                createAppIsSubmitting = false
            }
        }
    }

    private func yourOwnAppCard(for app: YourOwnOAuthApp) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.keyRound, size: 14)
                    .foregroundStyle(VColor.contentTertiary)

                Text(maskedClientId(app.client_id))
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Spacer()

                Text(formattedDate(app.created_at))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)

                if hoveredAppId == app.id {
                    Button {
                        appToDelete = app
                        showDeleteAppAlert = true
                    } label: {
                        VIconView(.trash, size: 14)
                            .foregroundStyle(VColor.systemNegativeStrong)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Delete OAuth App")
                    .transition(.opacity.animation(VAnimation.fast))
                }
            }

            Divider()
                .foregroundStyle(VColor.borderBase)

            let appConnections = store.yourOwnOAuthConnectionsByApp[app.id] ?? []
            if appConnections.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleUser, size: 14)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("No connected accounts")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .padding(.vertical, VSpacing.xxs)
            } else {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(appConnections) { conn in
                        yourOwnConnectionRow(for: conn, appId: app.id)
                    }
                }
            }

            HStack(spacing: VSpacing.sm) {
                if store.yourOwnOAuthConnectingAppId == app.id {
                    VButton(label: "Cancel", leftIcon: "lucide-x", style: .outlined) {
                        store.cancelYourOwnOAuthConnect()
                    }
                    VBusyIndicator(size: 8, color: VColor.contentTertiary)
                    Text("Waiting for authorization...")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
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
                .foregroundStyle(VColor.contentSecondary)

            Text(conn.account_info ?? "\(displayName) Account")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)

            Spacer()

            VTag("Connected", color: VColor.systemPositiveStrong, icon: .circleCheck)

            VButton(label: "Disconnect", style: .dangerOutline, size: .compact) {
                yourOwnDisconnectConnection = conn
                yourOwnDisconnectAppId = appId
                showYourOwnDisconnectAlert = true
            }
        }
        .padding(.vertical, VSpacing.xxs)
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
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}
