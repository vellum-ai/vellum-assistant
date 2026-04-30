import SwiftUI
import VellumAssistantShared

/// Single editable row in `CallSiteOverridesSheet`. Renders a call site's
/// display name, a short description, an inline profile picker (when the
/// override toggle is ON), and a toggle. Selecting "Custom" in the profile
/// picker reveals side-by-side provider and model dropdowns below the row.
///
/// State ownership:
/// - The `draft` binding is the row's working copy. The parent sheet owns
///   the list of drafts and persists them via the footer Save button.
/// - `original` is the persisted value from the store. It drives the
///   "unsaved changes" indicator.
@MainActor
struct CallSiteOverrideRow: View {
    @Binding var draft: CallSiteOverride
    let original: CallSiteOverride
    let providerIds: [String]
    /// The user's currently-selected default provider. Used to seed the
    /// override picker when the toggle flips ON so the row starts on the
    /// provider the user actually defaults to, not whatever happens to come
    /// first in the catalog (which can pin the wrong provider on Save).
    let defaultProvider: String
    let providerDisplayName: (String) -> String
    let availableModels: [String: [String]]
    let modelDisplayName: (String, String) -> String
    /// Named inference profiles available for selection. Sourced from
    /// `store.profiles` by the parent sheet.
    let profiles: [InferenceProfile]

    /// Internal sentinel value used in the profile picker to surface the
    /// provider+model form. The picker option is labeled "Custom" — this
    /// underscore-prefixed value exists only to disambiguate from any
    /// user-created profile that happens to be named "Custom".
    static let customSentinel = "__custom__"
    static let customLabel = "Custom"

    // MARK: - Computed State

    /// True when the toggle is in the "Override default" position. Mirrors
    /// "draft has any non-nil provider/model/profile". Toggling this off
    /// clears the draft locally.
    private var isOverrideOn: Bool {
        draft.hasOverride
    }

    /// True when the row's draft differs from what's persisted. Drives the
    /// parent sheet's Save button enabled state.
    private var hasUnsavedChanges: Bool {
        draft.provider != original.provider
            || draft.model != original.model
            || draft.profile != original.profile
    }

    /// Validation: when the user has picked a provider but no model yet,
    /// Save is blocked.
    var validationError: String? {
        let provider = draft.provider ?? ""
        let model = draft.model ?? ""
        if !provider.isEmpty && model.isEmpty {
            return "Pick a model"
        }
        return nil
    }

    /// True when the user is editing a raw fragment (Custom) rather than
    /// picking a profile.
    private var isCustomMode: Bool {
        Self.profilePickerValue(for: draft) == Self.customSentinel
    }

    /// Computes the profile picker's current value from the draft's state.
    static func profilePickerValue(for draft: CallSiteOverride) -> String {
        if draft.provider != nil || draft.model != nil {
            return Self.customSentinel
        }
        if let profile = draft.profile, !profile.isEmpty {
            return profile
        }
        return ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            headerRow

            if isOverrideOn && isCustomMode {
                customFields
            }
        }
        .padding(.vertical, VSpacing.xs)
        .animation(VAnimation.fast, value: isOverrideOn)
        .animation(VAnimation.fast, value: isCustomMode)
    }

    // MARK: - Header

    private var headerRow: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(draft.displayName)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                if !draft.callSiteDescription.isEmpty {
                    Text(draft.callSiteDescription)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if isOverrideOn {
                inlineProfilePicker
            }

            VToggle(
                isOn: Binding(
                    get: { isOverrideOn },
                    set: { newValue in
                        if newValue {
                            if !draft.hasOverride {
                                if let firstProfile = profiles.first {
                                    draft.profile = firstProfile.name
                                } else {
                                    seedCustomFragment()
                                }
                            }
                        } else {
                            draft.provider = nil
                            draft.model = nil
                            draft.profile = nil
                        }
                    }
                ),
                interactive: true
            )
            .accessibilityLabel("\(draft.displayName) override default")
        }
    }

    // MARK: - Inline Profile Picker

    private var inlineProfilePicker: some View {
        VDropdown(
            placeholder: "Profile\u{2026}",
            selection: Binding(
                get: { Self.profilePickerValue(for: draft) },
                set: { newValue in
                    let current = Self.profilePickerValue(for: draft)
                    guard newValue != current else { return }
                    if newValue == Self.customSentinel {
                        draft.profile = nil
                        if draft.provider == nil && draft.model == nil {
                            seedCustomFragment()
                        }
                    } else {
                        draft.provider = nil
                        draft.model = nil
                        draft.profile = newValue
                    }
                }
            ),
            options: profiles.map { (label: $0.displayName, value: $0.name) }
                + [(label: Self.customLabel, value: Self.customSentinel)],
            maxWidth: 150,
            menuWidth: 150
        )
    }

    // MARK: - Custom Provider/Model Fields

    private var customFields: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Provider")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Provider\u{2026}",
                        selection: Binding(
                            get: { draft.provider ?? "" },
                            set: { newValue in
                                let normalized = newValue.isEmpty ? nil : newValue
                                guard normalized != draft.provider else { return }
                                draft.provider = normalized
                                if let provider = normalized {
                                    let firstModel = availableModels[provider]?.first ?? ""
                                    draft.model = firstModel.isEmpty ? nil : firstModel
                                } else {
                                    draft.model = nil
                                }
                            }
                        ),
                        options: providerIds.map { provider in
                            (label: providerDisplayName(provider), value: provider)
                        }
                    )
                }

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Model")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    let provider = draft.provider ?? ""
                    let models = availableModels[provider] ?? []
                    VDropdown(
                        placeholder: models.isEmpty ? "Provider first" : "Model\u{2026}",
                        selection: Binding(
                            get: { draft.model ?? "" },
                            set: { newValue in
                                draft.model = newValue.isEmpty ? nil : newValue
                            }
                        ),
                        options: models.map { id in
                            (label: modelDisplayName(provider, id), value: id)
                        }
                    )
                    .disabled(provider.isEmpty || models.isEmpty)
                }
            }

            if let error = validationError {
                Text(error)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(.leading, VSpacing.md)
        .padding(.bottom, VSpacing.md)
    }

    // MARK: - Helpers

    private func seedCustomFragment() {
        let seedProvider = providerIds.contains(defaultProvider)
            ? defaultProvider
            : (providerIds.first ?? "anthropic")
        draft.provider = seedProvider
        let firstModel = availableModels[seedProvider]?.first ?? ""
        draft.model = firstModel.isEmpty ? nil : firstModel
    }
}
