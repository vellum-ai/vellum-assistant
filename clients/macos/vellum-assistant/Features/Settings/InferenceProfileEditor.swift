import SwiftUI
import VellumAssistantShared

/// Form view that edits a single `InferenceProfile` fragment. Mirrors the
/// daemon's `LLMConfigFragment` shape — see `assistant/src/config/schemas/
/// llm.ts` — exposing the leaves the macOS UI cares about: provider, model,
/// maxTokens (maximum output tokens), contextWindow.maxInputTokens, effort,
/// speed, verbosity, temperature, and the two `thinking` sub-fields.
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

    /// Schema default for `llm.default.maxTokens`. Profiles that omit
    /// `maxTokens` inherit this through the resolver, so the slider displays
    /// it as the default position without writing a profile override.
    static let defaultMaxOutputTokens: Int = 64_000

    /// Keep the editor range positive to match the daemon schema.
    static let minSliderMaxOutputTokens: Int = 1
    static let maxOutputTokensStep: Double = 1_000

    /// Conservative inherited context-window budget for profiles that do
    /// not opt into a larger/smaller explicit value. Mirrors the daemon's
    /// current default.
    static let defaultContextWindowTokens: Int = 200_000

    /// Lowest context-window value offered by the UI. The daemon schema
    /// remains independently positive; this only keeps slider snaps sane.
    static let minSliderContextWindowTokens: Int = 50_000
    static let contextWindowTokensStep: Double = 50_000

    /// Tracks whether the user has manually edited the Key field. When
    /// false, the key auto-derives from the Display Name as kebab-case.
    @State private var isKeyDirty: Bool = false

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
                    labelField
                    descriptionField
                    keyField
                    providerField
                    modelField
                    if visibility.maxTokens {
                        maxTokensField
                    }
                    contextWindowField
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
        .onAppear {
            // Only treat the key as user-owned for edits and views of
            // existing profiles. Creates and duplicates keep the key
            // auto-derived from Display Name so renaming stays in sync.
            if !isCreating {
                isKeyDirty = true
            }
        }
    }

    // MARK: - Toolbar

    private var editorHeader: some View {
        HStack(spacing: VSpacing.sm) {
            Text(editorTitle)
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            if isReadOnly {
                VBadge(label: "Vellum", tone: .neutral, emphasis: .subtle)
                    .help("Profiles managed by Vellum cannot be edited, but can be copied")
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

    private var labelField: some View {
        labeled("Display Name") {
            VTextField(
                placeholder: "e.g. Fast & Cheap",
                text: Binding(
                    get: { profile.label ?? "" },
                    set: { newValue in
                        profile.label = newValue.isEmpty ? nil : newValue
                        if !isKeyDirty {
                            profile.name = Self.toKebabCase(newValue)
                        }
                    }
                )
            )
        }
    }

    private var descriptionField: some View {
        labeled("Description") {
            VTextField(
                placeholder: "e.g. Fastest responses at lower cost",
                text: Binding(
                    get: { profile.profileDescription ?? "" },
                    set: { profile.profileDescription = $0.isEmpty ? nil : $0 }
                )
            )
        }
    }

    private var keyField: some View {
        labeled("Key") {
            VTextField(
                placeholder: "profile-key",
                text: Binding(
                    get: { profile.name },
                    set: { newValue in
                        isKeyDirty = true
                        profile.name = newValue
                    }
                )
            )
        }
    }

    /// Converts a display name to a kebab-case key.
    /// "Fast & Cheap" → "fast-cheap", "My Profile" → "my-profile"
    static func toKebabCase(_ input: String) -> String {
        input
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }

    var availableProviderIds: [String] {
        if store.inferenceMode == "managed" {
            return store.managedCapableProviders.map(\.id)
        }
        return store.dynamicProviderIds
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
                        Self.clampMaxOutputTokensForSelectedModel(&profile)
                        Self.clampContextWindowForSelectedModel(&profile)
                    }
                ),
                options: availableProviderIds.map { provider in
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
                        Self.clampMaxOutputTokensForSelectedModel(&profile)
                        Self.clampContextWindowForSelectedModel(&profile)
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
        let limit = selectedModelMaxOutputTokens
        let value = Self.maxOutputSliderValue(maxTokens: profile.maxTokens, limit: limit)
        let upperBound = Self.maxOutputSliderUpperBound(value: value, limit: limit)

        return labeled(
            "Max Output Tokens",
            spacing: VSpacing.sm,
            accessory: {
                Spacer(minLength: 0)
                Text(maxOutputTokensAccessoryText(value: value, limit: limit))
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        ) {
            HStack(spacing: VSpacing.sm) {
                if let limit {
                    VSlider(
                        value: Binding(
                            get: { Double(Self.maxOutputSliderValue(maxTokens: profile.maxTokens, limit: limit)) },
                            set: { newValue in
                                profile.maxTokens = Self.clampedMaxOutputTokens(Int(newValue.rounded()), limit: limit)
                            }
                        ),
                        range: Double(Self.minSliderMaxOutputTokens)...Double(upperBound),
                        step: Self.maxOutputTokensStep,
                        showTickMarks: true
                    )
                    .help("Maximum tokens the model may generate in one response.")
                    .accessibilityLabel("Max output tokens")
                    .accessibilityValue(Self.formattedTokenCount(value))
                } else {
                    VSlider(
                        value: .constant(Double(value)),
                        range: Double(Self.minSliderMaxOutputTokens)...Double(upperBound),
                        step: Self.maxOutputTokensStep,
                        showTickMarks: true
                    )
                    .disabled(true)
                    .help("Max output token metadata is unavailable for this model.")
                    .accessibilityLabel("Max output tokens")
                    .accessibilityValue(Self.formattedTokenCount(value))
                }
                VButton(
                    label: "Inherit",
                    style: .ghost,
                    size: .compact,
                    isDisabled: profile.maxTokens == nil
                ) {
                    profile = Self.clearingMaxOutputTokensOverride(profile)
                }
            }
        }
    }

    private var contextWindowField: some View {
        let model = selectedModelEntry
        let limit = model?.contextWindowTokens
        let value = Self.contextWindowSliderValue(
            maxInputTokens: profile.contextWindowMaxInputTokens,
            model: model
        )
        let upperBound = Self.contextWindowSliderUpperBound(value: value, limit: limit)

        return labeled(
            "Context Window",
            spacing: VSpacing.sm,
            accessory: {
                Spacer(minLength: 0)
                Text(contextWindowAccessoryText(value: value, model: model))
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        ) {
            VSlider(
                value: Binding(
                    get: {
                        Double(Self.contextWindowSliderValue(
                            maxInputTokens: profile.contextWindowMaxInputTokens,
                            model: model
                        ))
                    },
                    set: { newValue in
                        guard let limit else { return }
                        profile.contextWindowMaxInputTokens = Self.clampedContextWindowTokens(
                            Int(newValue.rounded()),
                            limit: limit
                        )
                    }
                ),
                range: Double(Self.minSliderContextWindowTokens)...Double(upperBound),
                step: Self.contextWindowTokensStep,
                showTickMarks: true
            )
            .disabled(limit == nil)
            .help(
                limit == nil
                    ? "Context window metadata is unavailable for this model."
                    : "Maximum input tokens the assistant may keep in context."
            )
            .accessibilityLabel("Context window")
            .accessibilityValue(Self.formattedTokenCount(value))
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

    var selectedModelMaxOutputTokens: Int? {
        Self.maxOutputTokenLimit(provider: profile.provider, model: profile.model)
    }

    var selectedModelEntry: LLMModelEntry? {
        Self.modelEntry(provider: profile.provider, model: profile.model)
    }

    static func modelEntry(provider rawProvider: String?, model rawModel: String?) -> LLMModelEntry? {
        guard
            let provider = rawProvider?.trimmingCharacters(in: .whitespacesAndNewlines),
            !provider.isEmpty,
            let model = rawModel?.trimmingCharacters(in: .whitespacesAndNewlines),
            !model.isEmpty
        else {
            return nil
        }
        return LLMProviderRegistry.model(provider: provider, id: model)
    }

    static func maxOutputTokenLimit(provider rawProvider: String?, model rawModel: String?) -> Int? {
        modelEntry(provider: rawProvider, model: rawModel)?.maxOutputTokens
    }

    static func maxOutputSliderValue(maxTokens: Int?, limit: Int?) -> Int {
        let value = max(maxTokens ?? defaultMaxOutputTokens, 1)
        guard let limit else { return value }
        return clampedMaxOutputTokens(value, limit: limit)
    }

    static func maxOutputSliderUpperBound(value: Int, limit: Int?) -> Int {
        max(minSliderMaxOutputTokens, limit ?? max(value, defaultMaxOutputTokens))
    }

    static func clampedMaxOutputTokens(_ value: Int, limit: Int) -> Int {
        min(max(value, 1), limit)
    }

    static func clearingMaxOutputTokensOverride(_ profile: InferenceProfile) -> InferenceProfile {
        var cleared = profile
        cleared.maxTokens = nil
        return cleared
    }

    static func clampMaxOutputTokensForSelectedModel(_ profile: inout InferenceProfile) {
        guard
            let current = profile.maxTokens,
            let limit = maxOutputTokenLimit(provider: profile.provider, model: profile.model)
        else {
            return
        }
        profile.maxTokens = clampedMaxOutputTokens(current, limit: limit)
    }

    static func contextWindowTokenLimit(provider rawProvider: String?, model rawModel: String?) -> Int? {
        modelEntry(provider: rawProvider, model: rawModel)?.contextWindowTokens
    }

    static func effectiveDefaultContextWindowTokens(model: LLMModelEntry?) -> Int {
        let defaultTokens = max(
            model?.defaultContextWindowTokens ?? defaultContextWindowTokens,
            minSliderContextWindowTokens
        )
        guard let limit = model?.contextWindowTokens else {
            return defaultTokens
        }
        return clampedContextWindowTokens(defaultTokens, limit: limit)
    }

    static func contextWindowSliderValue(maxInputTokens: Int?, model: LLMModelEntry?) -> Int {
        let value = max(
            maxInputTokens ?? effectiveDefaultContextWindowTokens(model: model),
            minSliderContextWindowTokens
        )
        guard let limit = model?.contextWindowTokens else { return value }
        return clampedContextWindowTokens(value, limit: limit)
    }

    static func contextWindowSliderUpperBound(value: Int, limit: Int?) -> Int {
        max(minSliderContextWindowTokens, limit ?? max(value, defaultContextWindowTokens))
    }

    static func clampedContextWindowTokens(_ value: Int, limit: Int) -> Int {
        min(max(value, minSliderContextWindowTokens), limit)
    }

    static func clampContextWindowForSelectedModel(_ profile: inout InferenceProfile) {
        guard
            let current = profile.contextWindowMaxInputTokens,
            let limit = contextWindowTokenLimit(provider: profile.provider, model: profile.model)
        else {
            return
        }
        profile.contextWindowMaxInputTokens = clampedContextWindowTokens(current, limit: limit)
    }

    static func formattedTokenCount(_ tokens: Int) -> String {
        guard tokens >= 1_000 else { return "\(tokens)" }
        return "\(Int((Double(tokens) / 1_000).rounded()))K"
    }

    private func maxOutputTokensAccessoryText(value: Int, limit: Int?) -> String {
        let valueText = Self.formattedTokenCount(value)
        guard let limit else {
            return "\(valueText) · catalog limit unavailable"
        }
        return "\(valueText) / \(Self.formattedTokenCount(limit)) max"
    }

    private func contextWindowAccessoryText(value: Int, model: LLMModelEntry?) -> String {
        let valueText = Self.formattedTokenCount(value)
        guard let limit = model?.contextWindowTokens else {
            return "\(valueText) · catalog limit unavailable"
        }
        var text = "\(valueText) / \(Self.formattedTokenCount(limit)) max"
        if let threshold = model?.longContextPricingThresholdTokens, value > threshold {
            text += " · long-context pricing"
        }
        return text
    }

    private func saveVisibleProfile() {
        var visibleProfile = parameterVisibility.sanitized(profile)
        Self.clampMaxOutputTokensForSelectedModel(&visibleProfile)
        Self.clampContextWindowForSelectedModel(&visibleProfile)
        profile = visibleProfile
        onSave()
    }
}
