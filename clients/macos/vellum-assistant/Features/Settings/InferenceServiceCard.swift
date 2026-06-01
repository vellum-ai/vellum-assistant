import SwiftUI
import VellumAssistantShared

/// Card for the inference service: active profile selector and management
/// buttons for provider connections, profiles, and per-call-site overrides.
///
/// Profiles already carry the provider they dispatch against, so the card
/// does not surface a separate global "default Provider" picker — picking a
/// profile picks its provider transitively. Provider connections themselves
/// are managed through the "Providers" button.
@MainActor
struct InferenceServiceCard: View {
    @ObservedObject var store: SettingsStore
    var assistantFeatureFlagStore: AssistantFeatureFlagStore
    var showToast: (String, ToastInfo.Style) -> Void

    /// Whether the read-only per-call-site overrides sheet is presented.
    @State private var showOverridesSheet = false
    /// Whether the inference profiles management sheet is presented.
    @State private var showProfilesSheet = false
    /// Whether the provider connections management sheet is presented.
    @State private var showProvidersSheet = false
    /// The most recent in-flight `setActiveProfile` task, retained so a
    /// subsequent dropdown pick can cancel it and avoid an out-of-order
    /// PATCH landing the older selection last.
    @State private var activeProfileTask: Task<Void, Never>?

    var body: some View {
        SettingsCard(title: "Language Model", subtitle: "Configure the LLMs that power your assistant") {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                activeProfilePicker
                secondaryActionsRow
            }
        }
        .sheet(isPresented: $showOverridesSheet) {
            CallSiteOverridesSheet(
                store: store,
                isPresented: $showOverridesSheet,
                assistantFeatureFlagStore: assistantFeatureFlagStore
            )
        }
        .sheet(isPresented: $showProfilesSheet) {
            InferenceProfilesSheet(
                store: store,
                isPresented: $showProfilesSheet,
                assistantFeatureFlagStore: assistantFeatureFlagStore
            )
        }
        .sheet(isPresented: $showProvidersSheet) {
            ProvidersSheet(store: store, isPresented: $showProvidersSheet, assistantFeatureFlagStore: assistantFeatureFlagStore)
        }
    }

    // MARK: - Secondary Actions Row

    private var secondaryActionsRow: some View {
        let overridesLabel = store.overridesCount > 0
            ? "\(store.overridesCount) Override\(store.overridesCount == 1 ? "" : "s")"
            : "Overrides"

        return HStack(spacing: VSpacing.sm) {
            VButton(label: "Providers", style: .ghost, size: .compact) {
                showProvidersSheet = true
            }
            VButton(label: "Profiles", style: .ghost, size: .compact) {
                showProfilesSheet = true
            }
            VButton(label: overridesLabel, style: .ghost, size: .compact) {
                showOverridesSheet = true
            }
        }
    }

    // MARK: - Active Profile Picker

    private var activeProfileBinding: Binding<String> {
        Binding(
            get: { store.activeProfile },
            set: { newValue in
                guard newValue != store.activeProfile else { return }
                activeProfileTask?.cancel()
                activeProfileTask = Task { _ = await store.setActiveProfile(newValue) }
            }
        )
    }

    /// Profiles surfaced in the Default Profile dropdown, with the
    /// meta-"auto" profile filtered out when `query-complexity-routing`
    /// is disabled. The auto profile is a routing meta-target, not a
    /// real default, so it must never be picked as the workspace's
    /// active profile while the flag is off.
    private var visibleProfiles: [InferenceProfile] {
        InferenceProfile.gateAutoProfile(
            store.profiles,
            queryComplexityRoutingEnabled: assistantFeatureFlagStore.isEnabled("query-complexity-routing")
        )
    }

    private var activeProfilePicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Default Profile")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a profile\u{2026}",
                selection: activeProfileBinding,
                options: visibleProfiles.map { (label: $0.displayName, value: $0.name) }
            )
        }
    }
}
