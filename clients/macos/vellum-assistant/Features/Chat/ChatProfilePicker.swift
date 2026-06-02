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

    @Environment(AssistantFeatureFlagStore.self) private var assistantFeatureFlagStore

    /// Pill label: the override profile's display name when set, otherwise
    /// "Default (`<activeProfile>`)". The seeded auto profile is surfaced as
    /// "Auto" when it is the effective profile.
    static func label(current: String?, profiles: [InferenceProfile], activeProfile: String, autoRouting: Bool = false) -> String {
        if current == InferenceProfile.autoProfileName {
            return "Auto"
        }
        if let current {
            return profiles.first(where: { $0.name == current })?.displayName ?? current
        }
        if autoRouting && activeProfile == InferenceProfile.autoProfileName {
            return "Auto"
        }
        let activeDisplay = profiles.first(where: { $0.name == activeProfile })?.displayName ?? activeProfile
        return "Default (\(activeDisplay))"
    }

    /// Chat pickers render "Auto" as a dedicated nil-selection row, so the
    /// seeded meta-profile should never appear in the regular profile list.
    /// Disabled profiles stay hidden unless they are the selected value.
    static func visibleProfilesForPicker(
        _ profiles: [InferenceProfile],
        selectedNames: [String?] = []
    ) -> [InferenceProfile] {
        let selected = Set(selectedNames.compactMap { $0 }.filter { !$0.isEmpty })
        return profiles.filter { profile in
            guard profile.name != InferenceProfile.autoProfileName else { return false }
            return !profile.isDisabled || selected.contains(profile.name)
        }
    }

    var body: some View {
        let autoRoutingEnabled = assistantFeatureFlagStore.isEnabled("query-complexity-routing")
        let effectiveProfile = current ?? activeProfile
        let activeProfiles = Self.visibleProfilesForPicker(profiles, selectedNames: [effectiveProfile])
        let isAutoActive = autoRoutingEnabled && effectiveProfile == InferenceProfile.autoProfileName
        let pillLabel = Self.label(current: current, profiles: activeProfiles, activeProfile: activeProfile, autoRouting: autoRoutingEnabled)
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
            if autoRoutingEnabled {
                VMenuItem(
                    icon: VIcon.wand.rawValue,
                    label: "Auto",
                    isActive: isAutoActive,
                    size: .regular
                ) {
                    onSelect(InferenceProfile.autoProfileName)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if isAutoActive {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }

            ForEach(activeProfiles) { profile in
                VMenuItem(
                    icon: VIcon.sparkles.rawValue,
                    label: profile.displayName,
                    isActive: !isAutoActive && current == profile.name,
                    size: .regular
                ) {
                    onSelect(profile.name)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if !isAutoActive && current == profile.name {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }

            if !autoRoutingEnabled {
                VMenuItem(
                    icon: VIcon.rotateCcw.rawValue,
                    label: "Reset to default (\(activeProfiles.first { $0.name == activeProfile }?.displayName ?? activeProfile))",
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
        }
        #endif
    }
}
