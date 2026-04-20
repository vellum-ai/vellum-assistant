import SwiftUI
import VellumAssistantShared

/// Single editable row in `CallSiteOverridesSheet`. Renders a call site's
/// display name plus a compact summary, an "Override default" toggle, and
/// — when the toggle is ON — provider/model pickers with Save/Reset
/// actions.
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
    let onSave: () -> Void
    let onClear: () -> Void

    /// Local expansion state. Defaults to "expanded when the row already has
    /// an override or when the user toggles it on" so a freshly-opened sheet
    /// shows configured rows expanded but leaves untouched rows collapsed.
    @State private var isExpanded: Bool = false

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

    private var canSave: Bool {
        guard hasUnsavedChanges else { return false }
        return validationError == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            headerRow

            if isExpanded && isOverrideOn {
                editor
            }
        }
        .padding(.vertical, VSpacing.xs)
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
                            // Switching ON: seed with the user's actual
                            // default provider so the picker starts where
                            // the user already operates. Falling back to
                            // catalog order would silently pin a different
                            // provider on Save when the catalog's first
                            // entry isn't the user's default.
                            if !draft.hasOverride {
                                let seedProvider: String
                                if providerIds.contains(defaultProvider) {
                                    seedProvider = defaultProvider
                                } else {
                                    seedProvider = providerIds.first ?? "anthropic"
                                }
                                draft.provider = seedProvider
                                let firstModel = availableModels[seedProvider]?.first ?? ""
                                draft.model = firstModel.isEmpty ? nil : firstModel
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

    // MARK: - Editor (provider/model pickers + actions)

    private var editor: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            providerPicker
            modelPicker

            if let error = validationError {
                Text(error)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Reset to Default",
                    style: .ghost
                ) {
                    onClear()
                }
                Spacer(minLength: 0)
                VButton(
                    label: "Save",
                    style: .primary,
                    isDisabled: !canSave
                ) {
                    onSave()
                }
            }
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.md, bottom: 0, trailing: 0))
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
        if let provider = draft.provider, let model = draft.model {
            parts.append("\(providerDisplayName(provider)) \u{00B7} \(modelDisplayName(provider, model))")
        } else if let model = draft.model {
            parts.append(model)
        } else if let provider = draft.provider {
            parts.append("Provider: \(providerDisplayName(provider))")
        }
        if let profile = draft.profile {
            parts.append("Profile: \(profile)")
        }
        if hasUnsavedChanges {
            parts.append("Unsaved")
        }
        return parts.joined(separator: " \u{00B7} ")
    }
}
