import SwiftUI
import VellumAssistantShared

/// Card for the inference service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode and auth state:
/// - **Managed + logged in**: Model picker, Save button
/// - **Managed + not logged in**: Empty state prompting login
/// - **Your Own**: Provider picker, API key field, model picker, Save + Reset buttons
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

    /// True when changing inference mode would invalidate the current web search config.
    private var wouldInvalidateWebSearch: Bool {
        let modeChanging = draftMode != store.inferenceMode
        guard modeChanging else { return false }

        // Switching to Your Own inference while web search is Managed
        // (managed web search requires managed inference).
        if draftMode == "your-own" && store.webSearchMode == "managed" {
            return true
        }
        // Switching to Managed inference while web search uses Provider Native
        // (Provider Native requires Your Own inference).
        if draftMode == "managed" && store.webSearchProvider == "inference-provider-native" {
            return true
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
        let effectiveDraftProvider = draftMode == "managed" ? "anthropic" : draftProvider
        let providerChanged = effectiveDraftProvider != initialProvider
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
                        PickerWithInlineSave(
                            hasChanges: hasChanges,
                            isSaving: store.apiKeySaving,
                            onSave: { save() }
                        ) {
                            modelPicker
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
            // provider requires an API key and the user hasn't configured one.
            // Providers like Ollama that don't use keys (apiKeyPlaceholder is
            // nil) are left alone since the user intentionally set up a local
            // provider.
            let providerRequiresKey = store.dynamicProviderApiKeyPlaceholder(draftProvider) != nil
            let hasLocalKey = APIKeyManager.getKey(for: draftProvider) != nil
            if isLoggedIn && draftMode == "your-own" && providerRequiresKey && !hasLocalKey {
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
                // When a user signs in and has no BYO key for a key-based
                // provider, default to managed. Keyless providers (e.g. Ollama)
                // are left in your-own mode.
                let requiresKey = store.dynamicProviderApiKeyPlaceholder(draftProvider) != nil
                let hasLocalKey = APIKeyManager.getKey(for: draftProvider) != nil
                if requiresKey && !hasLocalKey {
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
                let anthropicModels = store.dynamicProviderModels("anthropic")
                let isCurrentModelAnthropic = anthropicModels.contains { $0.id == draftModel }
                if !isCurrentModelAnthropic {
                    let defaultModel = store.dynamicProviderDefaultModel("anthropic")
                    draftModel = defaultModel.isEmpty ? "claude-opus-4-6" : defaultModel
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
                "Changing your inference mode will also update your Web Search settings."
                    + " You'll need to review and save them below."
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

    // MARK: - API Key Field

    private var apiKeyField: some View {
        let placeholder: String = {
            if providerHasKey {
                return "••••••••••••••••"
            }
            if let providerPlaceholder = store.dynamicProviderApiKeyPlaceholder(effectiveProvider), !providerPlaceholder.isEmpty {
                return providerPlaceholder
            }
            return "Enter your API key"
        }()
        return VTextField(
            "\(providerDisplayName) API Key",
            placeholder: placeholder,
            text: $apiKeyText,
            isSecure: true,
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
        let provider = draftMode == "managed" ? "anthropic" : draftProvider
        return VDropdown(
            placeholder: "Select a model\u{2026}",
            selection: $draftModel,
            options: store.dynamicProviderModels(provider).map { model in
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
        store.apiKeySaveError = nil

        // Detect mode change before persisting so downstream logic can
        // force-persist provider/model even when IDs happen to match.
        let modeChanged = draftMode != store.inferenceMode

        // Persist mode if changed
        let pendingMode = modeChanged ? store.setInferenceMode(draftMode) : nil

        // Persist provider if changed. Also re-persist when the mode
        // changed — switching between managed and your-own implies a
        // provider change even if the resolved provider ID happens to
        // match initialProvider (ensures config stays consistent).
        let persistProvider = draftMode == "managed" ? "anthropic" : draftProvider
        let providerChanged = persistProvider != initialProvider || modeChanged
        let pendingProvider = providerChanged ? store.setLLMDefaultProvider(persistProvider) : nil
        if providerChanged {
            initialProvider = persistProvider
        }
        // Normalize draftProvider to match what was persisted so hasChanges
        // (which compares draftProvider against initialProvider) stays in sync.
        if draftProvider != persistProvider {
            draftProvider = persistProvider
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

        // Await the mode and provider patches before writing the model so the
        // daemon's read-modify-write cycle for the model doesn't overwrite them.
        store.selectedModel = draftModel
        let capturedModel = draftModel
        let saveProvider = draftMode == "managed" ? "anthropic" : draftProvider
        let forceSend = modeChanged
        Task {
            if let pendingMode { _ = await pendingMode.value }
            if let pendingProvider { _ = await pendingProvider.value }
            _ = await store.setLLMDefaultModel(
                capturedModel,
                provider: saveProvider,
                force: forceSend
            ).value
        }
        initialModel = draftModel
    }
}
