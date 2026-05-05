import SwiftUI
import VellumAssistantShared

/// Bundle of the per-conversation inference-profile state and the persistence
/// callback the composer threads through to ``ChatProfilePicker``. A single optional
/// parameter on ``ComposerView`` / ``ComposerSection`` toggles the pill.
struct ChatProfilePickerConfiguration {
    /// The current per-conversation inference-profile override. `nil` means
    /// the conversation inherits `activeProfile`.
    let current: String?

    /// Profiles available to pick from — typically `SettingsStore.profiles`.
    let profiles: [InferenceProfile]

    /// The workspace `llm.activeProfile`. Rendered in the pill label when
    /// `current` is `nil`.
    let activeProfile: String

    /// Persists a selection. Passing `nil` clears the override so the
    /// conversation falls back to `activeProfile`.
    let onSelect: (String?) -> Void
}

/// A compact pill button in the composer action bar that lets the user pick a
/// per-conversation inference profile override. Draft conversations stage the
/// selected profile locally until the first message creates the conversation.
/// Opens a dropdown with every profile defined in `SettingsStore.profiles`,
/// plus a "Reset to default" item that clears the override and falls back to
/// `llm.activeProfile`.
///
/// State ownership: the pill is stateless. The label is derived from the
/// `current` override plus `activeProfile`; selection is forwarded straight to
/// `ConversationManager.setConversationInferenceProfile(id:profile:)` which
/// updates the local conversation model and persists to the daemon.
@MainActor
struct ChatProfilePicker: View {
    /// Whether the picker can be opened. The actual persistence or staging
    /// destination is captured into ``onSelect`` by the parent.
    let isEnabled: Bool

    /// The current per-conversation inference-profile override. `nil` means
    /// the conversation inherits `activeProfile`.
    let current: String?

    /// Profiles available to pick from — typically `SettingsStore.profiles`.
    let profiles: [InferenceProfile]

    /// The workspace `llm.activeProfile`. Surfaced in the pill label when
    /// `current` is `nil` so the user can see which profile the conversation
    /// will inherit.
    let activeProfile: String

    /// Persists a selection. Passing `nil` clears the override so the
    /// conversation falls back to `activeProfile`.
    let onSelect: (String?) -> Void

    /// Pill label: the override profile's display name when set, otherwise
    /// "Default (`<activeProfile>`)". Internal so tests can assert on it
    /// without spinning up a SwiftUI host.
    static func label(current: String?, profiles: [InferenceProfile], activeProfile: String) -> String {
        if let current {
            return profiles.first(where: { $0.name == current })?.displayName ?? current
        }
        let activeDisplay = profiles.first(where: { $0.name == activeProfile })?.displayName ?? activeProfile
        return "Default (\(activeDisplay))"
    }

    var body: some View {
        let pillLabel = Self.label(current: current, profiles: profiles, activeProfile: activeProfile)
        #if os(macOS)
        ComposerPillMenu(
            isEnabled: isEnabled,
            accessibilityLabel: "Inference profile",
            accessibilityValue: pillLabel,
            tooltip: "Inference profile for this conversation"
        ) {
            VIconView(.sparkles, size: 14)
                .foregroundStyle(VColor.contentSecondary)
            Text(pillLabel)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(1)
        } menu: {
            ForEach(profiles) { profile in
                VMenuItem(
                    icon: VIcon.sparkles.rawValue,
                    label: profile.displayName,
                    isActive: current == profile.name,
                    size: .regular
                ) {
                    onSelect(profile.name)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if current == profile.name {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }
            VMenuItem(
                icon: VIcon.rotateCcw.rawValue,
                label: "Reset to default (\(profiles.first { $0.name == activeProfile }?.displayName ?? activeProfile))",
                isActive: current == nil,
                size: .regular
            ) {
                onSelect(nil)
            } trailing: {
                VStack(alignment: .trailing, spacing: 2) {
                    if current == nil {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.primaryBase)
                    }
                }
            }
        }
        #endif
    }
}
