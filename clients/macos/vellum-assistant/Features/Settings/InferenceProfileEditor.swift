import SwiftUI
import VellumAssistantShared

/// Form view that edits a single `InferenceProfile` fragment. Mirrors the
/// daemon's `LLMConfigFragment` shape — see `assistant/src/config/schemas/
/// llm.ts` — exposing the leaves the macOS UI cares about: provider, model,
/// maxTokens, effort, speed, verbosity, temperature, and the two `thinking`
/// sub-fields.
///
/// State ownership:
/// - Edits flow through `@Binding var profile`, so the parent (the
///   profiles sheet introduced in PR 13) owns persistence and decides how
///   the draft maps onto `store.replaceProfile(name:fragment:)`.
/// - The provider/model dropdowns read their option lists from
///   `store.dynamicProviderIds` and `store.dynamicProviderModels(_:)`.
/// - Save and Cancel are wired to caller-provided closures so the parent
///   can decide where the buttons live (sheet header, toolbar, navigation
///   bar) without forcing a presentation style on the editor itself.
///
/// Validation: when `provider` is non-nil but `model` is nil OR not in the
/// catalog, Save is disabled and a warning badge appears next to the model
/// dropdown. Other partial states (e.g. provider nil but everything else
/// set) are intentionally allowed — they form a valid partial fragment.
@MainActor
struct InferenceProfileEditor: View {
    @ObservedObject var store: SettingsStore
    @Binding var profile: InferenceProfile
    var isReadOnly: Bool = false
    var isCreating: Bool = false
    let onSave: () -> Void
    var onSaveAs: (() -> Void)?
    let onCancel: () -> Void

    /// Effort ladder mirrors the daemon's `EffortLevel` schema. Includes
    /// `none` so users can disable effort entirely; `xhigh`/`max` mirror
    /// the OpenAI provider's higher-effort models.
    static let effortOptions: [String] = ["none", "low", "medium", "high", "xhigh", "max"]

    /// Speed mirrors the daemon's `SpeedSetting` schema.
    static let speedOptions: [String] = ["standard", "fast"]

    /// Verbosity mirrors the daemon's `VerbositySetting` schema.
    static let verbosityOptions: [String] = ["low", "medium", "high"]

    /// Temperature seeded when the user toggles the Set switch on. Also used
    /// as the slider's display fallback when the binding's value is nil so
    /// the slider position matches what the toggle-on path will write.
    private static let defaultTemperatureWhenSet: Double = 0.7

    /// Live-edited maxTokens text. Kept as a string so partial input
    /// (empty field, mid-typing) doesn't immediately clobber the binding
    /// with `0`. Synced into `profile.maxTokens` on every change.
    @State private var maxTokensText: String = ""

    // MARK: - Validation

    /// True when the user has picked a provider but no model — the most
    /// common partial-edit state. Disables Save and shows the badge.
    var isModelMissing: Bool {
        guard let provider = profile.provider, !provider.isEmpty else { return false }
        let model = profile.model ?? ""
        return model.isEmpty
    }

    /// True when the user has picked a provider/model combo where the
    /// model is not present in the provider's catalog. Treated the same
    /// as the missing case for Save purposes — the daemon would route to
    /// a model the provider doesn't know about.
    var isModelInvalid: Bool {
        guard let provider = profile.provider, !provider.isEmpty,
              let model = profile.model, !model.isEmpty else {
            return false
        }
        let catalog = store.dynamicProviderModels(provider).map(\.id)
        return !catalog.contains(model)
    }

    /// Combined gate for the Save button: any model-validation problem
    /// blocks Save.
    var canSave: Bool {
        !isModelMissing && !isModelInvalid
    }

    var parameterVisibility: InferenceProfileParameterVisibility {
        let provider = profile.provider ?? ""
        let model = profile.model ?? ""
        let knownModels = store.dynamicProviderModels(provider)
        let isKnownModel = knownModels.contains { $0.id == model }
        let modelEntry = LLMProviderRegistry.model(provider: provider, id: model)
        return InferenceProfileParameterVisibility.resolve(
            provider: provider,
            model: model,
            isKnownModel: isKnownModel,
            modelEntry: modelEntry
        )
    }

    // MARK: - Body

    var body: some View {
        let visibility = parameterVisibility
        VStack(alignment: .leading, spacing: 0) {
            editorHeader
            SettingsDivider()
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    nameField
                    providerField
                    modelField
                    if visibility.maxTokens {
                        maxTokensField
                    }
                    if visibility.effort {
                        effortField
                    }
                    if visibility.speed {
                        speedField
                    }
                    if visibility.verbosity {
                        verbosityField
                    }
                    if visibility.temperature {
                        temperatureField
                    }
                    if visibility.thinking {
                        thinkingSection
                    }
                }
                .padding(VSpacing.lg)
            }
            .disabled(isReadOnly)
            SettingsDivider()
            editorFooter
        }
        .background(VColor.surfaceLift)
        .onAppear { syncMaxTokensFromBinding() }
        .onChange(of: profile.maxTokens) { _, _ in syncMaxTokensFromBinding() }
    }

    // MARK: - Toolbar

    private var editorHeader: some View {
        HStack(spacing: VSpacing.sm) {
            Text(editorTitle)
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            if isReadOnly {
                VBadge(label: "Managed", tone: .neutral, emphasis: .subtle)
            }
            Spacer(minLength: 0)
            VButton(
                label: "Close",
                iconOnly: VIcon.x.rawValue,
                style: .ghost,
                tintColor: VColor.contentTertiary
            ) {
                onCancel()
            }
        }
        .padding(VSpacing.lg)
    }

    private var editorFooter: some View {
        HStack(spacing: VSpacing.sm) {
            Spacer(minLength: 0)
            if isReadOnly {
                VButton(label: "Close", style: .outlined) {
                    onCancel()
                }
                if let onSaveAs {
                    VButton(label: "Save As New", style: .primary) {
                        onSaveAs()
                    }
                }
            } else {
                VButton(label: "Cancel", style: .outlined) {
                    onCancel()
                }
                VButton(label: confirmLabel, style: .primary, isDisabled: !canSave) {
                    saveVisibleProfile()
                }
            }
        }
        .padding(VSpacing.lg)
    }

    private var editorTitle: String {
        if isReadOnly {
            return profile.displayName
        }
        return isCreating ? "New Profile" : "Edit Profile"
    }

    private var confirmLabel: String {
        isCreating ? "Create" : "Save"
    }

    // MARK: - Fields

    /// Field row: a small caption above the input, and an optional trailing
    /// accessory next to the caption (used for the model validation badge).
    private func labeled<Accessory: View, Content: View>(
        _ title: String,
        spacing: CGFloat = VSpacing.xs,
        @ViewBuilder accessory: () -> Accessory = { EmptyView() },
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: spacing) {
            HStack(spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                accessory()
            }
            content()
        }
    }

    private var nameField: some View {
        labeled("Name") {
            VTextField(
                placeholder: "Profile name",
                text: Binding(
                    get: { profile.name },
                    set: { profile.name = $0 }
                )
            )
        }
    }

    private var providerField: some View {
        labeled("Provider") {
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: Binding(
                    get: { profile.provider ?? "" },
                    set: { newValue in
                        let normalized = newValue.isEmpty ? nil : newValue
                        guard normalized != profile.provider else { return }
                        profile.provider = normalized
                        // Reset model when provider changes so we don't
                        // silently strand an incompatible model. Seeding
                        // with the new provider's catalog default keeps
                        // Save immediately reachable.
                        if let provider = normalized {
                            let defaultModel = store.dynamicProviderDefaultModel(provider)
                            let seeded = defaultModel.isEmpty
                                ? (store.dynamicProviderModels(provider).first?.id ?? "")
                                : defaultModel
                            profile.model = seeded.isEmpty ? nil : seeded
                        } else {
                            profile.model = nil
                        }
                    }
                ),
                options: store.dynamicProviderIds.map { provider in
                    (label: store.dynamicProviderDisplayName(provider), value: provider)
                }
            )
        }
    }

    private var modelField: some View {
        let provider = profile.provider ?? ""
        let models = store.dynamicProviderModels(provider)
        return labeled(
            "Model",
            accessory: {
                if isModelMissing || isModelInvalid {
                    VBadge(
                        label: isModelMissing ? "Pick a model" : "Not in catalog",
                        tone: .warning,
                        emphasis: .subtle
                    )
                }
            }
        ) {
            VDropdown(
                placeholder: models.isEmpty ? "Select a provider first" : "Select a model\u{2026}",
                selection: Binding(
                    get: { profile.model ?? "" },
                    set: { newValue in
                        profile.model = newValue.isEmpty ? nil : newValue
                    }
                ),
                options: models.map { model in
                    (label: model.displayName, value: model.id)
                }
            )
            .disabled(provider.isEmpty || models.isEmpty)
        }
    }

    private var maxTokensField: some View {
        labeled("Max Tokens") {
            VTextField(
                placeholder: "e.g. 16000",
                text: Binding(
                    get: { maxTokensText },
                    set: { newValue in
                        // Strip non-digit characters so paste-from-clipboard
                        // stays sane.
                        let digits = newValue.filter { $0.isNumber }
                        maxTokensText = digits
                        profile.maxTokens = digits.isEmpty ? nil : Int(digits)
                    }
                )
            )
        }
    }

    private var effortField: some View {
        labeled("Effort") {
            VSegmentControl(
                items: Self.effortOptions.map { (label: $0, tag: $0) },
                selection: Binding(
                    get: { profile.effort ?? "none" },
                    set: { newValue in
                        // "none" maps to nil so the fragment stays minimal
                        // and the resolver falls back to the layered default.
                        profile.effort = newValue == "none" ? nil : newValue
                    }
                )
            )
        }
    }

    private var speedField: some View {
        labeled("Speed") {
            VSegmentControl(
                items: Self.speedOptions.map { (label: $0, tag: $0) },
                selection: Binding(
                    get: { profile.speed ?? "standard" },
                    set: { profile.speed = $0 == "standard" ? nil : $0 }
                )
            )
        }
    }

    private var verbosityField: some View {
        labeled("Verbosity") {
            VSegmentControl(
                items: Self.verbosityOptions.map { (label: $0, tag: $0) },
                selection: Binding(
                    get: { profile.verbosity ?? "medium" },
                    set: { profile.verbosity = $0 == "medium" ? nil : $0 }
                )
            )
        }
    }

    private var temperatureField: some View {
        let currentValue = profile.temperature.doubleValue
        return labeled(
            "Temperature",
            spacing: VSpacing.sm,
            accessory: {
                Spacer(minLength: 0)
                Text(currentValue.map { String(format: "%.2f", $0) } ?? "—")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        ) {
            HStack(spacing: VSpacing.md) {
                VSlider(
                    value: Binding(
                        get: { profile.temperature.doubleValue ?? Self.defaultTemperatureWhenSet },
                        set: { profile.temperature = .value($0) }
                    ),
                    range: 0...2,
                    step: 0.05
                )
                .disabled(currentValue == nil)
                VToggle(
                    isOn: Binding(
                        get: { profile.temperature.doubleValue != nil },
                        set: { newValue in
                            // OFF: clear so the resolver falls back to the
                            // model-default temperature instead of pinning the
                            // seeded default. Maps to `.unset` rather than
                            // `.explicitNull` — the editor doesn't surface the
                            // explicit-null distinction; daemon-emitted
                            // explicit-null values still round-trip through
                            // the JSON mapper untouched.
                            profile.temperature = newValue
                                ? .value(Self.defaultTemperatureWhenSet)
                                : .unset
                        }
                    ),
                    label: "Set"
                )
            }
        }
    }

    private var thinkingSection: some View {
        labeled("Thinking", spacing: VSpacing.sm) {
            VToggle(
                isOn: Binding(
                    get: { profile.thinkingEnabled ?? false },
                    set: { profile.thinkingEnabled = $0 }
                ),
                label: "Enable thinking"
            )
            VToggle(
                isOn: Binding(
                    get: { profile.thinkingStreamThinking ?? false },
                    set: { profile.thinkingStreamThinking = $0 }
                ),
                label: "Stream thinking blocks"
            )
            // Stream-thinking is meaningless when thinking itself is off;
            // the daemon would ignore the leaf either way but the disabled
            // affordance keeps the UI honest.
            .disabled(!(profile.thinkingEnabled ?? false))
        }
    }

    // MARK: - Helpers

    /// Pull `profile.maxTokens` into the text-field shadow state. Called on
    /// appear and whenever the binding changes externally (e.g. parent
    /// resets the draft after a Save) so the field reflects the live value.
    private func syncMaxTokensFromBinding() {
        maxTokensText = profile.maxTokens.map(String.init) ?? ""
    }

    private func saveVisibleProfile() {
        profile = parameterVisibility.sanitized(profile)
        onSave()
    }
}
