import SwiftUI
import VellumAssistantShared

/// Card for the Google OAuth service with Managed/Your Own mode toggle.
///
/// Managed mode shows a connect flow for linking Google accounts.
/// Your Own mode shows a "Coming Soon" empty state.
/// The mode selection is persisted so user preference is retained.
@MainActor
struct GoogleOAuthServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        draftMode != store.googleOAuthMode
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
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
                comingSoonState
            }
        )
        .onAppear {
            draftMode = store.googleOAuthMode
            if store.googleOAuthMode == "managed" {
                Task { await store.fetchGoogleOAuthConnections() }
            }
        }
        .onChange(of: store.googleOAuthMode) { _, newValue in
            draftMode = newValue
            if newValue == "managed" {
                Task { await store.fetchGoogleOAuthConnections() }
            }
        }
        .onChange(of: isLoggedIn) { _, loggedIn in
            if loggedIn && draftMode == "managed" {
                Task { await store.fetchGoogleOAuthConnections() }
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
                    store.startGoogleOAuthConnect()
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
                Task { await authManager.startWorkOSLogin() }
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
                store.startGoogleOAuthConnect()
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
                store.disconnectGoogleOAuthConnection(entry.id)
            }
        }
    }

    // MARK: - Coming Soon

    private var comingSoonState: some View {
        Text("Coming soon.")
            .font(VFont.body)
            .foregroundColor(VColor.contentDefault)
    }

    // MARK: - Save

    private func save() {
        if draftMode != store.googleOAuthMode {
            store.setGoogleOAuthMode(draftMode)
        }
    }
}
