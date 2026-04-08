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
                VSegmentControl(
                    items: [
                        (label: "Managed", tag: "managed"),
                        (label: "Your Own", tag: "your-own"),
                    ],
                    selection: $draftMode
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
                VButton(label: "Confirm", style: .outlined, action: onClose)
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

    private let appearance = AvatarAppearanceManager.shared

    @ViewBuilder
    private var managedBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if !isLoggedIn {
                if authManager.isSubmitting {
                    VStack(spacing: VSpacing.md) {
                        VAvatarImage(image: appearance.chatAvatarImage, size: 48, showBorder: false)
                        HStack(spacing: VSpacing.sm) {
                            VBusyIndicator(size: 8, color: VColor.contentTertiary)
                            Text("Logging in...")
                                .font(VFont.bodyMediumDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.xl)
                } else {
                    integrationEmptyState(buttonLabel: "Log in to Vellum", buttonIcon: VIcon.logOut.rawValue) {
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
            } else if connections.isEmpty {
                if isConnecting {
                    VStack(spacing: VSpacing.md) {
                        VAvatarImage(image: appearance.chatAvatarImage, size: 48, showBorder: false)
                        HStack(spacing: VSpacing.sm) {
                            VBusyIndicator(size: 8, color: VColor.contentTertiary)
                            Text("Waiting for authorization...")
                                .font(VFont.bodyMediumDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, VSpacing.xl)
                } else {
                    integrationEmptyState {
                        store.startManagedOAuthConnect(providerKey: providerKey, userId: currentUserId)
                    }
                }
            } else {
                managedConnectionsList

                // Connect another account inside card area
                if isConnecting {
                    HStack(spacing: VSpacing.sm) {
                        VBusyIndicator(size: 8, color: VColor.contentTertiary)
                        Text("Waiting for authorization...")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                } else {
                    VButton(label: "Connect another account", leftIcon: VIcon.plus.rawValue, style: .outlined) {
                        store.startManagedOAuthConnect(providerKey: providerKey, userId: currentUserId)
                    }
                }
            }

            if let error = store.managedError(for: providerKey) {
                VInlineMessage(error, tone: .error)
            }
        }
    }

    private func integrationEmptyState(buttonLabel: String = "Connect Account", buttonIcon: String = VIcon.plus.rawValue, onConnect: @escaping () -> Void) -> some View {
        VStack(spacing: VSpacing.md) {
            VAvatarImage(image: appearance.chatAvatarImage, size: 48, showBorder: false)

            Text("Connect Account to continue")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)

            VButton(label: buttonLabel, leftIcon: buttonIcon, style: .outlined) {
                onConnect()
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xl)
    }


    private var managedConnectionsList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(connections, id: \.id) { entry in
                managedConnectionRow(for: entry)
            }
        }
    }

    private func managedConnectionRow(for entry: OAuthConnectionEntry) -> some View {
        VCard {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                VIconView(.circleUser, size: 14)
                    .foregroundStyle(VColor.contentSecondary)

                Text(entry.account_label ?? "\(displayName) Account")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()

                VButton(label: "", iconOnly: VIcon.trash.rawValue, style: .dangerOutline, size: .compact) {
                    connectionToDisconnect = entry
                    showDisconnectAlert = true
                }
                .accessibilityLabel("Disconnect Account")
            }
        }
    }

    // MARK: - Your Own Tab

    /// Whether the user is in the "add app" form step vs the app list step.
    @State private var isShowingAddAppForm = false
    @State private var isAddAppButtonHovered = false

    /// True when there are no apps yet, or the user clicked "Add Another App".
    private var shouldShowForm: Bool {
        store.yourOwnApps(for: providerKey).isEmpty || isShowingAddAppForm
    }

    @ViewBuilder
    private var yourOwnBody: some View {
        let apps = store.yourOwnApps(for: providerKey)
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if store.yourOwnIsLoading(for: providerKey) {
                yourOwnSkeleton
            } else if apps.isEmpty && !isShowingAddAppForm {
                integrationEmptyState {
                    createAppClientId = ""
                    createAppClientSecret = ""
                    isShowingAddAppForm = true
                }
            } else {
                if isShowingAddAppForm {
                    yourOwnFormStep
                }

                // App list
                if !apps.isEmpty {
                    ForEach(apps) { app in
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
        }
    }

    /// Credential entry form inside a card with Add/Cancel buttons
    private var yourOwnFormStep: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VTextField(
                "Client ID",
                placeholder: yourOwnMeta?.client_id_placeholder ?? "Enter your client ID",
                text: $createAppClientId
            )
            if yourOwnMeta?.requires_client_secret ?? true {
                VTextField(
                    "Client Secret",
                    placeholder: "Enter your client secret",
                    text: $createAppClientSecret,
                    isSecure: true
                )
            }
            if yourOwnMeta?.dashboard_url != nil {
                VInlineMessage("Find these in your \(displayName) Developer console.", tone: .info)
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: createAppIsSubmitting ? "Adding..." : "Add",
                    style: .primary,
                    isDisabled: createAppClientId.isEmpty || ((yourOwnMeta?.requires_client_secret ?? true) && createAppClientSecret.isEmpty) || createAppIsSubmitting
                ) {
                    createAppIsSubmitting = true
                    Task {
                        await store.createYourOwnOAuthApp(providerKey: providerKey, clientId: createAppClientId, clientSecret: createAppClientSecret)
                        createAppClientId = ""
                        createAppClientSecret = ""
                        createAppIsSubmitting = false
                        isShowingAddAppForm = false
                    }
                }
                VButton(label: "Cancel", style: .outlined) {
                    createAppClientId = ""
                    createAppClientSecret = ""
                    isShowingAddAppForm = false
                }
            }
        }
        .padding(VSpacing.lg)
        .vCard()
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

    private func yourOwnAppCard(for app: YourOwnOAuthApp) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Header: client ID, date, trash
                HStack(alignment: .center, spacing: VSpacing.lg) {
                    Text(maskedClientId(app.client_id))
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Spacer()

                    Text(formattedDate(app.created_at))
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    VButton(label: "", iconOnly: VIcon.trash.rawValue, style: .dangerOutline, size: .compact) {
                        appToDelete = app
                        showDeleteAppAlert = true
                    }
                    .accessibilityLabel("Delete OAuth App")
                }

                // Connections or empty state
                let appConnections = store.yourOwnOAuthConnectionsByApp[app.id] ?? []
                if appConnections.isEmpty {
                    Text("No connected accounts")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                } else {
                    ForEach(appConnections) { conn in
                        yourOwnConnectionRow(for: conn, appId: app.id)
                    }
                }

                // Connect button
                if store.yourOwnOAuthConnectingAppId == app.id {
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Cancel", leftIcon: "lucide-x", style: .outlined) {
                            store.cancelYourOwnOAuthConnect()
                        }
                        VBusyIndicator(size: 8, color: VColor.contentTertiary)
                        Text("Waiting for authorization...")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                } else {
                    VButton(
                        label: "Connect another account",
                        leftIcon: "lucide-external-link",
                        style: .outlined,
                        isDisabled: store.yourOwnOAuthConnectingAppId != nil
                    ) {
                        store.startYourOwnOAuthConnect(appId: app.id)
                    }
                }
            }
        }
    }

    @State private var hoveredYourOwnConnId: String?

    private func yourOwnConnectionRow(for conn: YourOwnOAuthConnection, appId: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.circleUser, size: 14)
                .foregroundStyle(VColor.contentSecondary)

            Text(conn.account_info ?? "\(displayName) Account")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer()

            if hoveredYourOwnConnId == conn.id {
                Button {
                    yourOwnDisconnectConnection = conn
                    yourOwnDisconnectAppId = appId
                    showYourOwnDisconnectAlert = true
                } label: {
                    VIconView(.trash, size: 14)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Disconnect Account")
                .transition(.opacity.animation(VAnimation.fast))
            }
        }
        .padding(.vertical, VSpacing.xxs)
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredYourOwnConnId = hovering ? conn.id : nil
            }
        }
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
