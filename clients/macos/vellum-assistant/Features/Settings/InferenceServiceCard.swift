import SwiftUI
import VellumAssistantShared

/// Card for the inference service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode and auth state:
/// - **Managed + logged in**: Provider picker (managed-capable only), model picker, Save button
/// - **Managed + not logged in**: Empty state prompting login
/// - **Your Own**: Provider picker (all), API key field, model picker, Save + Reset buttons
@MainActor
struct InferenceServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    @Binding var apiKeyText: String
    var showToast: (String, ToastInfo.Style) -> Void

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"
    /// Local draft of the model selection — only persisted on Save.
    @State private var draftModel: String = ""
    /// Snapshot of the model at card appear — used to detect model-only changes.
    @State private var initialModel: String = ""
    /// Whether to show the web search impact confirmation alert.
    @State private var showWebSearchAlert = false
    /// Local draft of the provider selection — only persisted on Save.
    @State private var draftProvider: String = "anthropic"
    /// Snapshot of the provider at card appear — used to detect provider changes.
    @State private var initialProvider: String = ""
    /// Guards against provider-change side-effects during initial load.
    @State private var didInitialSync = false
    /// Set `true` right before an external store sync updates `draftProvider`,
    /// so `onChange(of: draftProvider)` can distinguish daemon-driven updates
    /// from user-initiated picks and skip the model/key reset.
    @State private var isSyncingProviderFromStore = false
    /// Whether the current provider has a stored API key (fetched per-component).
    @State private var providerHasKey = false
    /// Whether the read-only per-call-site overrides sheet is presented.
    @State private var showOverridesSheet = false
    /// Whether to show the per-call-site override confirmation dialog. Fires
    /// when the user is about to switch the global provider AND has at least
    /// one override pinned to the OLD provider — we ask whether to keep those
    /// pins or reset them to follow the new default.
    @State private var showOverrideConfirmation = false
    /// Snapshot of the overrides pinned to the OLD provider at the moment the
    /// confirmation dialog is shown. Used both to render the dialog message
    /// (count + provider name) and to drive the "Reset" action.
    @State private var pendingOverrideClears: [CallSiteOverride] = []
    /// The provider name displayed in the confirmation dialog message.
    /// Captured at confirmation time so the message stays accurate even if
    /// `initialProvider` is mutated during the deferred save.
    @State private var pendingOverrideOldProviderName: String = ""

    // MARK: - Provider Helpers

    private var effectiveProvider: String {
        draftProvider
    }

    private var providerDisplayName: String {
        store.dynamicProviderDisplayName(effectiveProvider)
    }

    // MARK: - Computed State

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    /// True when changing inference mode/provider would invalidate the current web search config.
    private var wouldInvalidateWebSearch: Bool {
        let modeChanging = draftMode != store.inferenceMode
        let providerChanging = draftProvider != store.selectedInferenceProvider
        guard modeChanging || providerChanging else { return false }

        // Switching to Your Own inference while web search is Managed
        // (managed web search requires managed inference).
        if modeChanging && draftMode == "your-own" && store.webSearchMode == "managed" {
            return true
        }
        // Switching to Managed inference while web search uses Provider Native —
        // only invalidate when the resulting provider cannot support native web search.
        // Skip when web search is in managed mode (webSearchProvider is stale).
        if draftMode == "managed" && store.webSearchMode == "your-own" && store.webSearchProvider == "inference-provider-native" {
            if !store.isNativeWebSearchCapable(draftProvider, model: draftModel) {
                return true
            }
        }
        // Switching providers while web search uses Provider Native — invalidate
        // when the new provider cannot support native web search.
        // Skip when web search is in managed mode (webSearchProvider is stale).
        if providerChanging && store.webSearchMode == "your-own" && store.webSearchProvider == "inference-provider-native" {
            if !store.isNativeWebSearchCapable(draftProvider, model: draftModel) {
                return true
            }
        }
        return false
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        // In managed mode when not logged in, there is nothing actionable to save.
        if draftMode == "managed" && !isLoggedIn {
            return false
        }
        // A valid model must be selected to save.
        if draftModel.isEmpty {
            return false
        }
        let modeChanged = draftMode != store.inferenceMode
        let hasNewKey = draftMode == "your-own" && !apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let modelChanged = draftModel != initialModel
        let providerChanged = draftProvider != initialProvider
        return modeChanged || hasNewKey || modelChanged || providerChanged
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ServiceModeCard(
                title: "Inference",
                subtitle: draftMode == "managed"
                    ? "Configure which model to use to power your assistant"
                    : "Configure which LLM provider and model to use to power your assistant",
                draftMode: $draftMode,
                managedContent: {
                    if isLoggedIn {
                        VStack(alignment: .leading, spacing: VSpacing.sm) {
                            managedProviderPicker
                            PickerWithInlineSave(
                                hasChanges: hasChanges,
                                isSaving: store.apiKeySaving,
                                onSave: { save() }
                            ) {
                                modelPicker
                            }
                        }
                    } else {
                        managedLoginPrompt
                    }
                },
                yourOwnContent: {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        providerPicker

                        // Model picker
                        modelPicker

                        // API Key field
                        apiKeyField

                        // Action buttons
                        ServiceCardActions(
                            hasChanges: hasChanges,
                            isSaving: store.apiKeySaving,
                            onSave: { save() },
                            savingLabel: "Validating...",
                            onReset: {
                                store.clearAPIKeyForProvider(effectiveProvider)
                                providerHasKey = false
                                apiKeyText = ""
                            },
                            showReset: providerHasKey
                        )
                    }
                }
            )

            // Per-call-site overrides badge — only visible when the user has
            // at least one override configured. Tapping opens the overrides
            // sheet.
            if store.overridesCount > 0 {
                overridesBadge
            }
        }
        .sheet(isPresented: $showOverridesSheet) {
            CallSiteOverridesSheet(store: store, isPresented: $showOverridesSheet)
        }
        .onAppear {
            draftMode = store.inferenceMode
            draftModel = store.selectedModel
            initialModel = store.selectedModel
            draftProvider = store.selectedInferenceProvider
            initialProvider = store.selectedInferenceProvider
            didInitialSync = true

            // If the user is not authenticated and the persisted mode is
            // "managed", reset the draft so the UI shows "your-own".
            // When auth is still loading (startup), only reset the draft —
            // the persisted mode is preserved so it can be restored when
            // auth completes. When auth is confirmed absent, also persist
            // the reset so the daemon doesn't attempt managed-proxy routing.
            if !isLoggedIn && draftMode == "managed" {
                draftMode = "your-own"
                if !authManager.isLoading {
                    store.setInferenceMode("your-own")
                }
            }

            // Symmetric case: if the user is authenticated and the mode is
            // still the default "your-own", switch to "managed" so signed-in
            // users get managed inference out of the box — but only when the
            // provider is managed-capable, requires an API key, and the user
            // hasn't configured one. Providers like Ollama that don't use keys
            // (apiKeyPlaceholder is nil) or non-managed providers (fireworks,
            // openrouter) are left alone since the user intentionally set up
            // that provider.
            let providerRequiresKey = store.dynamicProviderApiKeyPlaceholder(draftProvider) != nil
            let hasLocalKey = APIKeyManager.getKey(for: draftProvider) != nil
            let providerIsManagedCapable = store.isManagedCapable(draftProvider)
            if isLoggedIn && draftMode == "your-own" && providerIsManagedCapable && providerRequiresKey && !hasLocalKey {
                draftMode = "managed"
                store.setInferenceMode("managed")
            }
        }
        .onChange(of: store.inferenceMode) { _, newValue in
            // Sync draft when external changes arrive (e.g. daemon reload),
            // but guard against adopting managed mode while unauthenticated.
            if newValue == "managed" && !isLoggedIn {
                draftMode = "your-own"
            } else {
                draftMode = newValue
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if !isAuthenticated && draftMode == "managed" {
                // When the user logs out while this card is mounted, reset
                // both the draft and the persisted mode so the daemon doesn't
                // attempt managed-proxy routing while unauthenticated.
                draftMode = "your-own"
                store.setInferenceMode("your-own")
            } else if isAuthenticated && store.inferenceMode == "managed" {
                // When auth becomes available (e.g. startup transition from
                // loading to authenticated), restore the persisted managed
                // mode that onAppear may have temporarily overridden.
                draftMode = "managed"
            } else if isAuthenticated && store.inferenceMode == "your-own" {
                // When a user signs in and has no BYO key for a managed-capable,
                // key-based provider, default to managed. Keyless providers
                // (e.g. Ollama) and non-managed providers are left in your-own mode.
                let requiresKey = store.dynamicProviderApiKeyPlaceholder(draftProvider) != nil
                let hasLocalKey = APIKeyManager.getKey(for: draftProvider) != nil
                let isManagedCapable = store.isManagedCapable(draftProvider)
                if isManagedCapable && requiresKey && !hasLocalKey {
                    draftMode = "managed"
                    store.setInferenceMode("managed")
                }
            }
        }
        .onChange(of: authManager.isLoading) { _, isLoading in
            // When auth finishes loading without authenticating, persist
            // the mode reset that onAppear deferred during the loading
            // state. Without this, the persisted mode stays "managed"
            // while the UI shows "your-own" — pressing Save for unrelated
            // edits would not trigger a mode change since draftMode already
            // equals the visual state.
            if !isLoading && !isLoggedIn && store.inferenceMode == "managed" {
                store.setInferenceMode("your-own")
            }
        }
        .onChange(of: store.selectedInferenceProvider) { _, newValue in
            // Sync draft & baseline when the daemon reports a provider
            // update. Also refresh the model baseline so hasChanges does
            // not flag a stale diff against the old provider's model.
            // Flag the update so onChange(of: draftProvider) skips the
            // model/key reset that is only appropriate for user picks.
            let alreadyEqual = draftProvider == newValue
            isSyncingProviderFromStore = true
            draftProvider = newValue
            // If draftProvider already held this value, SwiftUI's
            // onChange(of: draftProvider) won't fire (it only fires on
            // actual value transitions), so clear the flag immediately
            // to prevent the next user-initiated change from being
            // misclassified as a store sync.
            if alreadyEqual {
                isSyncingProviderFromStore = false
            }
            initialProvider = newValue
            draftModel = store.selectedModel
            initialModel = store.selectedModel
        }
        .onChange(of: store.selectedModel) { _, newValue in
            // Sync draft & baseline when external changes arrive (e.g. daemon model info refresh)
            draftModel = newValue
            initialModel = newValue
        }
        .onChange(of: draftProvider) { _, newProvider in
            // Only reset the model and API key text for user-initiated
            // provider changes. Skip during initial load (onAppear sets
            // draftProvider before didInitialSync is true) and during
            // external store syncs (which set isSyncingProviderFromStore
            // before updating draftProvider).
            if isSyncingProviderFromStore {
                isSyncingProviderFromStore = false
                return
            }
            guard didInitialSync else { return }
            let defaultModel = store.dynamicProviderDefaultModel(newProvider)
            let fallback = store.dynamicProviderModels(newProvider).first?.id ?? ""
            draftModel = defaultModel.isEmpty ? fallback : defaultModel
            apiKeyText = ""
        }
        .onChange(of: draftMode) { _, newMode in
            if newMode == "managed" {
                // When switching to managed mode, fall back to a managed-capable
                // provider if the current one does not support managed routing.
                if !store.isManagedCapable(draftProvider) {
                    draftProvider = "anthropic"
                }
                // Validate the model against the selected managed provider's catalog.
                let managedModels = store.dynamicProviderModels(draftProvider)
                let isCurrentModelValid = managedModels.contains { $0.id == draftModel }
                if !isCurrentModelValid {
                    let defaultModel = store.dynamicProviderDefaultModel(draftProvider)
                    draftModel = defaultModel.isEmpty
                        ? (managedModels.first?.id ?? "")
                        : defaultModel
                }
            } else if newMode == "your-own" {
                let providerModels = store.dynamicProviderModels(draftProvider)
                let isCurrentModelValid = providerModels.contains { $0.id == draftModel }
                if !isCurrentModelValid {
                    let defaultModel = store.dynamicProviderDefaultModel(draftProvider)
                    draftModel = defaultModel.isEmpty
                        ? (providerModels.first?.id ?? "")
                        : defaultModel
                }
            }
        }
        .task(id: effectiveProvider) {
            providerHasKey = await APIKeyManager.hasKey(for: effectiveProvider)
        }
        .alert("Heads up", isPresented: $showWebSearchAlert) {
            Button("Go Back", role: .cancel) {}
            Button("Continue") { performSave() }
        } message: {
            Text(
                "Changing your inference settings will also update your Web Search settings."
                    + " You'll need to review and save them below."
            )
        }
        .confirmationDialog(
            "Keep per-task overrides?",
            isPresented: $showOverrideConfirmation,
            titleVisibility: .visible
        ) {
            Button("Keep overrides") {
                performSaveCore(clearingOverrides: [])
            }
            Button("Reset to follow default") {
                performSaveCore(clearingOverrides: pendingOverrideClears)
            }
            Button("Cancel", role: .cancel) {
                pendingOverrideClears = []
                pendingOverrideOldProviderName = ""
            }
        } message: {
            Text(
                "\(pendingOverrideClears.count) task(s) are pinned to "
                    + "\(pendingOverrideOldProviderName). Keep them as-is, or "
                    + "update them to follow the new default?"
            )
        }
    }

    // MARK: - Per-Call-Site Overrides Badge

    /// Compact link-styled label that surfaces the count of explicit per-task
    /// overrides and opens the read-only overrides sheet on tap. Hidden by
    /// the parent when `store.overridesCount == 0`.
    private var overridesBadge: some View {
        Button {
            showOverridesSheet = true
        } label: {
            Text(
                "\(store.overridesCount) per-task override"
                    + (store.overridesCount == 1 ? "" : "s")
            )
            .font(VFont.bodySmallDefault)
            .foregroundStyle(.secondary)
            .underline()
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel("View per-task model overrides")
    }

    // MARK: - Managed Login Prompt

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to use managed inference.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
            VButton(
                label: authManager.isSubmitting ? "Logging in..." : "Log In",
                style: .primary,
                isDisabled: authManager.isSubmitting
            ) {
                Task {
                    await authManager.loginWithToast(showToast: showToast, onSuccess: {
                        if AppDelegate.shared?.isCurrentAssistantManaged ?? false {
                            AppDelegate.shared?.reconnectManagedAssistant()
                        }
                    })
                }
            }
        }
    }

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $draftProvider,
                options: store.dynamicProviderIds.map { provider in
                    (label: store.dynamicProviderDisplayName(provider), value: provider)
                }
            )
        }
    }

    /// Provider picker filtered to managed-capable providers, shown in managed mode.
    private var managedProviderPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $draftProvider,
                options: store.managedCapableProviders.map { entry in
                    (label: entry.displayName, value: entry.id)
                }
            )
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        APIKeyTextField(
            label: "\(providerDisplayName) API Key",
            hasKey: providerHasKey,
            text: $apiKeyText,
            emptyPlaceholder: {
                if let p = store.dynamicProviderApiKeyPlaceholder(effectiveProvider), !p.isEmpty { return p }
                return "Enter your API key"
            }(),
            errorMessage: store.apiKeySaveError
        )
        .disabled(store.apiKeySaving)
    }

    // MARK: - Model Picker

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Active Model")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            providerModelPicker
        }
    }

    /// Per-provider catalog model dropdown.
    private var providerModelPicker: some View {
        VDropdown(
            placeholder: "Select a model\u{2026}",
            selection: $draftModel,
            options: store.dynamicProviderModels(draftProvider).map { model in
                (label: model.displayName, value: model.id)
            }
        )
    }

    // MARK: - Save

    private func save() {
        if wouldInvalidateWebSearch {
            showWebSearchAlert = true
            return
        }
        performSave()
    }

    private func performSave() {
        let persistProvider = draftProvider

        // If the resolved provider ID is changing AND the user has any
        // per-call-site overrides pinned to the OLD provider, ask whether
        // to keep those pins or reset them. Only check when the actual
        // provider ID differs — a pure mode toggle (e.g. your-own →
        // managed) where both old and new resolve to the same provider
        // (e.g. both "anthropic") should not prompt because there is no
        // provider switch for overrides to reconcile against.
        let providerIdChanged = persistProvider != initialProvider
        if providerIdChanged {
            let overridesPinnedToOldProvider = store.callSiteOverrides.filter {
                $0.provider == initialProvider
            }
            if !overridesPinnedToOldProvider.isEmpty {
                pendingOverrideClears = overridesPinnedToOldProvider
                pendingOverrideOldProviderName = store.dynamicProviderDisplayName(initialProvider)
                showOverrideConfirmation = true
                return
            }
        }

        performSaveCore(clearingOverrides: [])
    }

    /// Persists the staged inference settings (mode, provider, API key, model).
    /// Runs the actual save work — `performSave()` decides whether to call
    /// this directly or to first prompt the user about per-call-site overrides
    /// pinned to the old provider.
    ///
    /// `clearingOverrides` is the set of overrides to clear before the save
    /// (e.g. when the user picks "Reset to follow default" from the override
    /// confirmation dialog). Pass an empty array to leave all overrides intact.
    private func performSaveCore(clearingOverrides overridesToClear: [CallSiteOverride]) {
        store.apiKeySaveError = nil

        // Clear any overrides the user opted to reset before persisting the
        // new defaults. Done first so the daemon sees the cleared overrides
        // when it processes the subsequent provider/model patches.
        for override in overridesToClear {
            _ = store.clearCallSiteOverride(override.id)
        }
        // Reset stash regardless of which path we came from so a future
        // confirmation dialog renders fresh state.
        pendingOverrideClears = []
        pendingOverrideOldProviderName = ""

        // Detect mode change before persisting so downstream logic can
        // force-persist provider/model even when IDs happen to match.
        let modeChanged = draftMode != store.inferenceMode

        // Persist mode if changed. The mode write goes to
        // `services.inference.mode`, separate from `llm.default` — but we
        // capture the pending Task so the provider/model PATCH below can
        // wait for it. Otherwise the daemon's ConfigWatcher could see the
        // provider/model write reflect new mode-derived defaults before the
        // mode itself has been persisted.
        let pendingMode = modeChanged ? store.setInferenceMode(draftMode) : nil

        // Resolve the provider that will land in `llm.default.provider`.
        // Also flag re-persist when the mode changed — switching between
        // managed and your-own implies a provider change even if the
        // resolved provider ID happens to match initialProvider (ensures
        // config stays consistent).
        let persistProvider = draftProvider
        let providerChanged = persistProvider != initialProvider || modeChanged
        if providerChanged {
            initialProvider = draftProvider
        }

        // Persist API key if entered and in your-own mode.
        // saveAPIKey / saveInferenceAPIKey is async (validates with the provider before storing).
        // The key text is kept until validation succeeds so the user can retry.
        let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if draftMode == "your-own" && !trimmedKey.isEmpty {
            let keyTextBinding = $apiKeyText
            let displayName = providerDisplayName
            store.saveInferenceAPIKey(trimmedKey, provider: effectiveProvider, onSuccess: { [self] in
                providerHasKey = true
                keyTextBinding.wrappedValue = ""
                showToast("\(displayName) API key saved", .success)
            })
        }

        // Persist provider+model atomically in a single PATCH when either
        // changed (or when the mode toggled, which forces a re-persist
        // even when the resolved IDs match). Splitting the write into two
        // PATCHes (provider first, model second) lets the daemon's
        // ConfigWatcher fire between them and reload providers with the
        // new provider but the OLD model — potentially incompatible
        // (e.g. an OpenAI model ID against the Anthropic provider). The
        // combined setter writes both keys in one round-trip so the
        // daemon never observes a half-applied state.
        //
        // Awaiting `pendingMode` first ensures `services.inference.mode`
        // has landed before the daemon picks up the new provider/model.
        let modelChanged = draftModel != initialModel
        if providerChanged || modelChanged {
            let capturedProvider = persistProvider
            let capturedModel = draftModel
            Task {
                if let pendingMode { _ = await pendingMode.value }
                _ = await store.setLLMDefault(provider: capturedProvider, model: capturedModel).value
            }
        }
        initialModel = draftModel
    }
}
