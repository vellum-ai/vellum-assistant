import SwiftUI
import VellumAssistantShared

/// Single editable row in `CallSiteOverridesSheet`. Renders a call site's
/// display name plus a compact summary, an "Override default" toggle, and
/// — when the toggle is ON — a profile picker. Most rows pick a named
/// inference profile; a `"Custom"` entry (backed by an internal sentinel
/// value so it can't collide with a user-chosen profile name) reveals the
/// legacy provider+model form for one-off overrides that don't fit any
/// profile.
///
/// State ownership:
/// - The `draft` binding is the row's working copy. The parent sheet owns
///   the list of drafts so it can compute "any unsaved changes" for the
///   "Save All" header button.
/// - `original` is the persisted value from the store. It drives the
///   "unsaved changes" pill and toggle defaulting (when the user hasn't
///   touched the row yet).
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
    let onSave: () -> Void
    let onClear: () -> Void
    /// Invoked when the user picks a named profile from the picker. The
    /// parent sheet routes this through
    /// `store.replaceCallSiteOverride(id:profile:)` which clears any
    /// stale fragment fields server-side, and refreshes the draft so the
    /// row converges immediately.
    let onSelectProfile: (String) -> Void

    /// Local expansion state. Defaults to "expanded when the row already has
    /// an override or when the user toggles it on" so a freshly-opened sheet
    /// shows configured rows expanded but leaves untouched rows collapsed.
    @State private var isExpanded: Bool = false

    /// Internal sentinel value used in the profile picker to surface the
    /// legacy provider+model form. Selecting it keeps the row in
    /// raw-fragment mode; the existing Save button persists the fragment.
    /// The picker option is labeled "Custom" — this underscore-prefixed
    /// value exists only to disambiguate from any user-created profile
    /// that happens to be named "Custom".
    static let customSentinel = "__custom__"
    static let customLabel = "Custom"

    // MARK: - Computed State

    /// True when the toggle is in the "Override default" position. Mirrors
    /// "draft has any non-nil provider/model/profile". Toggling this off
    /// clears the draft locally so Save will write a `null` to the daemon.
    private var isOverrideOn: Bool {
        draft.hasOverride
    }

    /// True when the row's draft differs from what's persisted. Drives the
    /// Save button enable state and the parent sheet's "Save All" badge.
    private var hasUnsavedChanges: Bool {
        draft.provider != original.provider
            || draft.model != original.model
            || draft.profile != original.profile
    }

    /// Validation: when the user has picked a provider but no model yet,
    /// Save is blocked. This catches the most common partial-edit state
    /// without forcing a model-first ordering.
    private var validationError: String? {
        let provider = draft.provider ?? ""
        let model = draft.model ?? ""
        if !provider.isEmpty && model.isEmpty {
            return "Pick a model"
        }
        return nil
    }

    /// True when the user is editing a raw fragment (Custom) rather than
    /// picking a profile. Drives the visibility of the provider+model form
    /// and the per-row Save button (profile selection persists immediately
    /// via `onSelectProfile` so no Save click is needed).
    private var isCustomMode: Bool {
        Self.profilePickerValue(for: draft) == Self.customSentinel
    }

    private var canSave: Bool {
        guard hasUnsavedChanges else { return false }
        return validationError == nil
    }

    /// Computes the profile picker's current value from the draft's state.
    /// Returns the Custom sentinel when raw provider/model fragment fields
    /// are set (even alongside a profile, since `resolveCallSiteConfig`
    /// applies fragments after profile layering and they would silently
    /// shadow the named profile at runtime — surfacing them as Custom
    /// keeps the editor honest about what will actually run), the profile
    /// name when only a profile is set, or `""` when no override is
    /// active.
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

            if isExpanded && isOverrideOn {
                editor
            }
        }
        .padding(.vertical, VSpacing.xs)
        .animation(VAnimation.fast, value: isExpanded)
        .animation(VAnimation.fast, value: isOverrideOn)
        .onAppear {
            // Expand rows that are already configured so the user sees their
            // current settings without an extra click.
            if original.hasOverride {
                isExpanded = true
            }
        }
    }

    // MARK: - Header (title + toggle)

    private var headerRow: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            // Tap target for the title/summary expands the row when an
            // override is active. Use a Button so VoiceOver treats it as an
            // activation surface.
            Button {
                if isOverrideOn {
                    withAnimation(VAnimation.fast) { isExpanded.toggle() }
                }
            } label: {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(draft.displayName)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                    if !summary.isEmpty {
                        Text(summary)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityHint(isOverrideOn ? "Expands to edit override" : "")

            if isOverrideOn {
                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }

            VToggle(
                isOn: Binding(
                    get: { isOverrideOn },
                    set: { newValue in
                        if newValue {
                            // Switching ON: default new rows to the first
                            // profile when one is available so the common
                            // case is one click. Fall back to a Custom
                            // fragment seeded with the user's default
                            // provider when no profiles exist.
                            if !draft.hasOverride {
                                if let firstProfile = profiles.first {
                                    draft.profile = firstProfile.name
                                    // The per-row Save button is hidden in
                                    // profile mode, so persist immediately
                                    // — otherwise the auto-selection is
                                    // lost when the sheet closes.
                                    onSelectProfile(firstProfile.name)
                                } else {
                                    seedCustomFragment()
                                }
                            }
                            withAnimation(VAnimation.fast) { isExpanded = true }
                        } else {
                            // Switching OFF: clear locally so Save will write
                            // null to the daemon. Don't auto-save here — the
                            // user still has to confirm via the row's Save
                            // button or "Save All" in the sheet header.
                            draft.provider = nil
                            draft.model = nil
                            draft.profile = nil
                            withAnimation(VAnimation.fast) { isExpanded = false }
                        }
                    }
                ),
                interactive: true
            )
            .accessibilityLabel("\(draft.displayName) override default")
        }
    }

    // MARK: - Editor (profile picker + optional provider/model form)

    private var editor: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            profilePicker

            if isCustomMode {
                providerPicker
                modelPicker

                if let error = validationError {
                    Text(error)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Reset to Default",
                    style: .ghost
                ) {
                    onClear()
                }
                Spacer(minLength: 0)
                if isCustomMode {
                    VButton(
                        label: "Save",
                        style: .primary,
                        isDisabled: !canSave
                    ) {
                        onSave()
                    }
                }
            }
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.md, bottom: 0, trailing: 0))
    }

    private var profilePicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Profile")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a profile\u{2026}",
                selection: Binding(
                    get: { Self.profilePickerValue(for: draft) },
                    set: { newValue in
                        let current = Self.profilePickerValue(for: draft)
                        guard newValue != current else { return }
                        if newValue == Self.customSentinel {
                            // Switch to Custom: drop the profile reference
                            // and seed provider/model from the default so
                            // the form renders valid values.
                            draft.profile = nil
                            if draft.provider == nil && draft.model == nil {
                                seedCustomFragment()
                            }
                        } else {
                            // Switch to a named profile: clear fragment
                            // fields locally and persist via the parent's
                            // `onSelectProfile` callback, which routes
                            // through `replaceCallSiteOverride` to clear
                            // stale fragment leaves server-side.
                            draft.provider = nil
                            draft.model = nil
                            draft.profile = newValue
                            onSelectProfile(newValue)
                        }
                    }
                ),
                options: profiles.map { (label: $0.displayName, value: $0.name) }
                    + [(label: Self.customLabel, value: Self.customSentinel)]
            )
        }
    }

    /// Populates `draft.provider` and `draft.model` with the user's default
    /// provider and that provider's first model so a fresh Custom row
    /// renders with valid values rather than empty pickers (which would
    /// also fail Save validation).
    private func seedCustomFragment() {
        let seedProvider = providerIds.contains(defaultProvider)
            ? defaultProvider
            : (providerIds.first ?? "anthropic")
        draft.provider = seedProvider
        let firstModel = availableModels[seedProvider]?.first ?? ""
        draft.model = firstModel.isEmpty ? nil : firstModel
    }

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: Binding(
                    get: { draft.provider ?? "" },
                    set: { newValue in
                        let normalized = newValue.isEmpty ? nil : newValue
                        guard normalized != draft.provider else { return }
                        draft.provider = normalized
                        // Reset the model when the provider changes so the
                        // user doesn't end up saving a model that doesn't
                        // exist on the new provider. Seed with the new
                        // provider's first model so Save isn't immediately
                        // blocked by validation.
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
    }

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Model")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            let provider = draft.provider ?? ""
            let models = availableModels[provider] ?? []
            VDropdown(
                placeholder: models.isEmpty ? "Select a provider first" : "Select a model\u{2026}",
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

    // MARK: - Summary

    /// Inline subtitle describing the current draft (or "Follows default"
    /// when nothing is overridden). Keeps the row scannable when collapsed.
    private var summary: String {
        if !draft.hasOverride {
            return "Follows default"
        }
        var parts: [String] = []
        if let profile = draft.profile {
            let display = profiles.first(where: { $0.name == profile })?.displayName ?? profile
            parts.append(display)
        } else if let provider = draft.provider, let model = draft.model {
            parts.append("\(providerDisplayName(provider)) \u{00B7} \(modelDisplayName(provider, model))")
        } else if let model = draft.model {
            parts.append(model)
        } else if let provider = draft.provider {
            parts.append("Provider: \(providerDisplayName(provider))")
        }
        if hasUnsavedChanges {
            parts.append("Unsaved")
        }
        return parts.joined(separator: " \u{00B7} ")
    }
}
