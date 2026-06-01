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
    /// Provider connections available for the Connection sub-dropdown. The
    /// editor reads this list, filters by the currently-selected provider,
    /// and lets the user route the profile to a specific connection row. Defaults to nil so test constructions and callers
    /// that don't care about connection routing still compile — daemons
    /// older than the `provider_connection`-aware profile schema continue
    /// to behave as "pick the first active connection for the provider."
    ///
    /// `nil` vs `[]` is meaningful:
    /// - `nil` → the parent has not yet fetched `listProviderConnections`
    ///   (pre-load window between `.task` firing and the daemon response).
    ///   The provider picker falls back to the full catalog so the trigger
    ///   isn't empty during that gap.
    /// - `[]` → the daemon returned zero connections. A fresh workspace
    ///   with nothing configured. The provider picker filters to empty,
    ///   the empty-state hint fires, and the user is steered to Providers
    ///   instead of being allowed to pick a non-dispatchable provider.
    var connections: [ProviderConnection]? = nil
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

    /// Model IDs supported by ChatGPT subscription (oauth_subscription)
    /// connections. When the effective connection uses this auth type, the
    /// model picker is filtered to this set so the user doesn't select a
    /// model the subscription can't dispatch. Mirrors the web app's
    /// `CODEX_SUBSCRIPTION_MODEL_IDS` in `profile-editor-modal.tsx`.
    static let codexSubscriptionModelIds: Set<String> = [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex"
    ]

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

    /// Snapshot of `profile.label` captured when the editor appeared.
    /// Used by `hasViewModeChanges` to decide whether the view-mode Save
    /// button is enabled. View mode is reserved for managed profiles, so
    /// this snapshot represents the daemon-seeded label (or the user's
    /// most recent override of it).
    @State private var initialLabel: String?

    /// Snapshot of `profile.status` captured when the editor appeared.
    /// Compared against the current status via `isStatusActive(_:)` so
    /// the `nil`/`"active"` round-trip from the daemon doesn't read as
    /// a spurious change. See `hasViewModeChanges`.
    @State private var initialStatus: String?

    /// True when the editor is in view mode (managed-profile read of an
    /// existing profile) AND the user has touched either of the two
    /// fields that view mode permits editing (`label`, `status`).
    /// Drives the view-mode Save button's enabled state; without a
    /// change, view mode stays close-only.
    ///
    /// `label` comparison trims surrounding whitespace so a stray space
    /// doesn't read as a change. `status` comparison normalizes
    /// `nil`/`""`/`"active"` to the same "active" bucket so the daemon's
    /// stored shape (which may differ from the local-cache shape — see
    /// `setProfileStatus`'s `wireStatus` vs `nextLocalStatus`) doesn't
    /// trip a false-positive change.
    var hasViewModeChanges: Bool {
        guard isReadOnly else { return false }
        return Self.viewModeHasChanges(
            currentLabel: profile.label,
            initialLabel: initialLabel,
            currentStatus: profile.status,
            initialStatus: initialStatus
        )
    }

    /// Pure comparison driving `hasViewModeChanges`. Exposed so tests can
    /// exercise the label/status normalization without rendering the
    /// view (the instance variant depends on `@State` snapshots captured
    /// in `.onAppear`, which doesn't fire under XCTest).
    ///
    /// `label` compares trimmed-whitespace, so a stray trailing space
    /// doesn't read as a real change.
    /// `status` normalizes through `isStatusActive` so the daemon's
    /// nil-vs-"active" round-trip stays a no-op.
    static func viewModeHasChanges(
        currentLabel: String?,
        initialLabel: String?,
        currentStatus: String?,
        initialStatus: String?
    ) -> Bool {
        let labelEqual = (currentLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            == (initialLabel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let statusEqual = isStatusActive(currentStatus) == isStatusActive(initialStatus)
        return !labelEqual || !statusEqual
    }

    /// Normalizes the three "active" shapes (`nil`, empty string,
    /// literal `"active"`) into a single boolean so the local-vs-wire
    /// status comparison stays robust across daemon round-trips. Mirrors
    /// `InferenceProfile.isDisabled` semantics: only literal `"disabled"`
    /// reads as disabled.
    static func isStatusActive(_ status: String?) -> Bool {
        status != "disabled"
    }

    // MARK: - Validation

    /// True when the user hasn't picked a provider yet. Provider is now
    /// required (the old "None (inherit defaults)" affordance was removed
    /// because the inherit-defaults pathway encouraged accidental fallbacks
    /// to the global default model — defeating the point of named profiles).
    var isProviderMissing: Bool {
        let provider = profile.provider ?? ""
        return provider.isEmpty
    }

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
        if effectiveConnection?.auth.type == "oauth_subscription" {
            return !Self.codexSubscriptionModelIds.contains(model)
        }
        let catalogIds = store.dynamicProviderModels(provider).map(\.id)
        let connectionIds = effectiveConnection?.models?.map(\.id) ?? []
        return !catalogIds.contains(model) && !connectionIds.contains(model)
    }

    /// Combined gate for the Save button: provider must be picked AND
    /// model must be valid.
    var canSave: Bool {
        !isProviderMissing && !isModelMissing && !isModelInvalid
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
                    // Display Name stays editable in every mode — including
                    // view mode for managed profiles, where the daemon
                    // allows policy edits on `label` even though the seed
                    // contract (provider, model, advanced params) is
                    // locked. The Save button in the view-mode footer
                    // gates the persist call on `hasViewModeChanges`.
                    labelField

                    // Seed-owned fields: locked in view mode (managed
                    // profile read) so the user can't reshape the
                    // daemon-seeded contract from inside view mode. The
                    // duplicate path (Save As New) is the supported way
                    // to fork these into a user-owned profile.
                    Group {
                        descriptionField
                        keyField
                        providerField
                        connectionField
                        modelField
                        if visibility.maxTokens {
                            maxTokensField
                        }
                        contextWindowField
                    }
                    .disabled(isReadOnly)
                    Group {
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
                        if visibility.thinkingLevel {
                            thinkingLevelField
                        }
                    }
                    .disabled(isReadOnly)

                    // Status (active/disabled) is user policy in every
                    // mode for the same reason as `label`: managed
                    // profiles can be temporarily disabled without
                    // duplicating. Save in view mode persists the
                    // toggle along with any label change.
                    statusToggle
                }
                .padding(VSpacing.lg)
            }
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
            // Capture the policy-field baseline so the view-mode Save
            // button can light up only when the user actually changed
            // something. We re-capture on every `.onAppear` (not just
            // the first) because the editor view is unmounted when
            // `editorState` transitions to nil (parent sheet conditional
            // `if editorState != nil`), so switching between profiles
            // re-fires this closure with the new draft.
            initialLabel = profile.label
            initialStatus = profile.status
        }
    }

    // MARK: - Toolbar

    private var editorHeader: some View {
        HStack(spacing: VSpacing.sm) {
            Text(editorTitle)
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            if isReadOnly {
                VBadge(label: "Platform", tone: .positive, emphasis: .subtle)
                    .help("Profiles managed by Platform cannot be edited, but can be copied")
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
                // Save persists the two view-mode-editable fields
                // (`label`, `status`). Gated on `hasViewModeChanges` so an
                // untouched view session can't round-trip a no-op write,
                // and so the button visually communicates "nothing to save
                // yet" while the user is just browsing. The parent's
                // `commitEditor` detects view mode and routes through
                // `SettingsStore.setManagedProfilePolicy` rather than the
                // full `replaceProfile` path — sending only `{label,
                // status}` is required by the daemon's managed-profile
                // guard on `PUT /v1/config/llm/profiles/<name>`.
                VButton(label: "Save", style: .primary, isDisabled: !hasViewModeChanges) {
                    onSave()
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

    /// Provider IDs visible in the picker. Filtered to providers that
    /// have at least one ACTIVE connection — picking a provider with
    /// zero active connections binds the profile to a route the daemon
    /// can't dispatch through, leaving the user stuck. The currently-
    /// bound `provider` is always kept in the list so editing/viewing a
    /// stale profile (whose connection was disabled after the binding
    /// was saved) still renders a sensible trigger.
    ///
    /// Pre-load fallback: when `connections` is `nil` (the sheet's
    /// `.task` hasn't completed its first `listProviderConnections`
    /// fetch yet, or an older daemon that doesn't surface the connection
    /// list), return the full catalog so the user doesn't see an empty
    /// picker on first open. An EMPTY-but-loaded `connections == []` is
    /// distinct: the daemon confirmed zero connections, so the filter
    /// runs and yields empty — the empty-state hint fires and steers
    /// the user to Providers instead of letting them save a profile
    /// bound to a non-dispatchable provider.
    ///
    /// Mirrors web's `visibleProviders` + `providerOptionsSource` in
    /// `web/src/app/(app)/assistant/settings/ai/profile-editor-modal.tsx`
    /// (PR #6509). The web sibling has the same nil-vs-empty trap and
    /// is being addressed in a follow-up.
    var availableProviderIds: [String] {
        guard let connections else { return store.dynamicProviderIds }

        var activeProviderSet = Set<String>()
        for connection in connections {
            activeProviderSet.insert(connection.provider)
        }
        if let bound = profile.provider, !bound.isEmpty {
            activeProviderSet.insert(bound)
        }
        return store.dynamicProviderIds.filter { activeProviderSet.contains($0) }
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
                        // Reset connection binding too: a stale name almost
                        // certainly points at a different provider's row, and
                        // the daemon would reject it at resolve time. Falling
                        // back to "Any <provider> connection" matches the
                        // dispatcher's legacy behavior.
                        profile.providerConnection = nil
                        Self.clampMaxOutputTokensForSelectedModel(&profile)
                        Self.clampContextWindowForSelectedModel(&profile)
                    }
                ),
                options: availableProviderIds.map { provider in
                    (label: store.dynamicProviderDisplayName(provider), value: provider)
                }
            )
            if availableProviderIds.isEmpty && !isReadOnly {
                Text("No provider connections. Open Providers to add one.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    /// Connections that match the currently-selected provider. Used by
    /// `connectionField` to populate its dropdown. During pre-load
    /// (`connections == nil`) there's nothing to pick — the connection
    /// sub-dropdown stays hidden until the fetch completes.
    var availableConnectionsForProvider: [ProviderConnection] {
        guard let provider = profile.provider, !provider.isEmpty else { return [] }
        return (connections ?? []).filter { $0.provider == provider }
    }

    /// The currently-saved binding when it does NOT resolve to any active
    /// connection for the selected provider. `nil` when the binding is
    /// empty or when it does match. Used to gate the picker's "stale"
    /// affordances (extra dropdown option + warning badge).
    var staleProviderConnection: String? {
        guard let bound = profile.providerConnection, !bound.isEmpty else { return nil }
        return availableConnectionsForProvider.contains(where: { $0.name == bound })
            ? nil
            : bound
    }

    /// Connection sub-dropdown. Renders when a provider is selected AND
    /// either at least one active connection matches OR the profile has a
    /// non-empty saved binding (so a stale binding can be seen and cleared
    /// rather than silently round-tripping on save). The first option
    /// preserves the daemon's "first active" fallback so existing profiles
    /// keep working without an explicit migration.
    @ViewBuilder
    private var connectionField: some View {
        let available = availableConnectionsForProvider
        let stale = staleProviderConnection
        if let provider = profile.provider,
           !provider.isEmpty,
           (!available.isEmpty || stale != nil) {
            labeled(
                "Connection",
                accessory: {
                    // Surface the "stale binding" state: the saved name
                    // doesn't match any active connection for the provider.
                    // Most commonly this fires when a connection was
                    // disabled or deleted outside the editor.
                    if stale != nil {
                        VBadge(
                            label: "Not found",
                            tone: .warning,
                            emphasis: .subtle
                        )
                    }
                }
            ) {
                let baseOptions: [(label: String, value: String)] = [
                    (
                        label: "Any active \(store.dynamicProviderDisplayName(provider)) connection",
                        value: ""
                    )
                ] + available.map { conn in
                    (label: Self.connectionDisplayName(conn), value: conn.name)
                }
                // When the saved binding is stale, surface it as an explicit
                // dropdown option so the trigger renders its name. Selecting
                // "Any active …" clears the binding back to the daemon's
                // first-active fallback.
                let optionsWithStale: [(label: String, value: String)] =
                    stale.map { name in
                        baseOptions + [(label: "\(name) (not found)", value: name)]
                    } ?? baseOptions
                VDropdown(
                    placeholder: "Any active connection\u{2026}",
                    selection: Binding(
                        get: { profile.providerConnection ?? "" },
                        set: { newValue in
                            profile.providerConnection = newValue.isEmpty ? nil : newValue
                        }
                    ),
                    options: optionsWithStale
                )
            }
        }
    }

    /// Prefer the human-readable label when present; fall back to the
    /// connection's stored `name` (which is the on-disk identifier). Mirrors
    /// the convention used by `ProvidersSheet` row rendering so the two
    /// surfaces stay visually consistent.
    static func connectionDisplayName(_ conn: ProviderConnection) -> String {
        if let label = conn.label, !label.isEmpty { return label }
        return conn.name
    }

    private var selectedConnection: ProviderConnection? {
        guard let name = profile.providerConnection, !name.isEmpty else { return nil }
        return availableConnectionsForProvider.first { $0.name == name }
    }

    private var effectiveConnection: ProviderConnection? {
        selectedConnection ?? availableConnectionsForProvider.first
    }

    private var modelField: some View {
        let provider = profile.provider ?? ""
        let catalogModels: [CatalogModel] = {
            let allModels = store.dynamicProviderModels(provider)
            // When the effective connection uses ChatGPT subscription auth,
            // restrict to Codex-supported models. Mirrors the web app's
            // filter in profile-editor-modal.tsx.
            if effectiveConnection?.auth.type == "oauth_subscription" {
                return allModels.filter { Self.codexSubscriptionModelIds.contains($0.id) }
            }
            return allModels
        }()
        let connectionModels: [CatalogModel] = effectiveConnection?.models?.map {
            CatalogModel(id: $0.id, displayName: $0.displayName ?? $0.id)
        } ?? []
        let models = connectionModels.isEmpty ? catalogModels : connectionModels
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

    // Gemini's reasoning-depth knob. The model's supported levels come from
    // the catalog family rule; "default" omits `thinking.level` so the daemon
    // applies the model default (and clamps anything below a Pro model's floor).
    private var thinkingLevelField: some View {
        let levels = ["default"]
            + InferenceProfileParameterVisibility.geminiThinkingLevels(profile.model ?? "")
        return labeled("Thinking level") {
            VSegmentControl(
                items: levels.map { (label: $0, tag: $0) },
                selection: Binding(
                    get: { profile.thinkingLevel ?? "default" },
                    set: { profile.thinkingLevel = $0 == "default" ? nil : $0 }
                )
            )
        }
    }

    private var statusToggle: some View {
        labeled("Status") {
            VToggle(
                isOn: Binding(
                    get: { profile.status != "disabled" },
                    set: { profile.status = $0 ? nil : "disabled" }
                ),
                label: "Active"
            )
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
