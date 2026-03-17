import SwiftUI
import VellumAssistantShared

/// Card for the Google OAuth service with Managed/Your Own mode toggle.
///
/// Both modes currently show a "Coming Soon" empty state.
/// The mode selection is persisted so user preference is retained.
@MainActor
struct GoogleOAuthServiceCard: View {
    @ObservedObject var store: SettingsStore

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        draftMode != store.googleOAuthMode
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
                comingSoonState
            },
            yourOwnContent: {
                comingSoonState
            }
        )
        .onAppear {
            draftMode = store.googleOAuthMode
        }
        .onChange(of: store.googleOAuthMode) { _, newValue in
            draftMode = newValue
        }
    }

    // MARK: - Coming Soon

    private var comingSoonState: some View {
        VStack(spacing: VSpacing.md) {
            Text("Coming Soon")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Save

    private func save() {
        if draftMode != store.googleOAuthMode {
            store.setGoogleOAuthMode(draftMode)
        }
    }
}
