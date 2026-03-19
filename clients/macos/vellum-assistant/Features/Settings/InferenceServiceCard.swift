import SwiftUI
import VellumAssistantShared

/// Card for the inference service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode and auth state:
/// - **Managed + logged in**: Model picker, Save button
/// - **Managed + not logged in**: Empty state prompting login
/// - **Your Own**: API key field, model picker, Save + Reset buttons
///
/// When the `custom-inference-provider` feature flag is enabled,
/// shows an additional provider picker in Your Own mode, adapts the
/// API key label, and switches model catalogs per-provider.
@MainActor
struct InferenceServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    @Binding var apiKeyText: String
    var showToast: ((String, ToastInfo.Style) -> Void)?

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

    // MARK: - Feature Flag

    private var isCustomProviderEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("custom_inference_provider_enabled")
    }

    // MARK: - Provider Helpers

    /// When the flag is off, always Anthropic; when on, use the draft provider.
    private var effectiveProvider: String {
        isCustomProviderEnabled ? draftProvider : "anthropic"
    }

    private var providerDisplayName: String {
        store.dynamicProviderDisplayName(effectiveProvider)
    }

    // MARK: - Computed State

    private var isConnected: Bool {
        isCustomProviderEnabled ? store.hasKeyForProvider(effectiveProvider) : store.hasKey
    }

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
        let providerChanged = isCustomProviderEnabled && draftProvider != initialProvider
        return modeChanged || hasNewKey || modelChanged || providerChanged
    }

    var body: some View {
        ServiceModeCard(
            title: "Inference",
            subtitle: "Configure which LLM provider and model to use to power your assistant",
            draftMode: $draftMode,
            hasChanges: hasChanges,
            isSaving: store.apiKeySaving,
            onSave: { save() },
            onReset: {
                if isCustomProviderEnabled {
                    store.clearAPIKeyForProvider(effectiveProvider)
                } else {
                    store.clearAPIKey()
                }
                apiKeyText = ""
            },
            showReset: isConnected,
            managedContent: {
                if isLoggedIn {
                    modelPicker
                } else {
                    managedLoginPrompt
                }
            },
            yourOwnContent: {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    if isCustomProviderEnabled {
                        providerPicker
                    }

                    // Model picker
                    modelPicker

                    // API Key field
                    apiKeyField
                }
            }
        )
        .onAppear {
            draftMode = store.inferenceMode
            draftModel = store.selectedModel
            initialModel = store.selectedModel
            draftProvider = store.selectedInferenceProvider
            initialProvider = store.selectedInferenceProvider

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
            draftProvider = newValue
            initialProvider = newValue
        }
        .onChange(of: store.selectedModel) { _, newValue in
            // Sync draft & baseline when external changes arrive (e.g. daemon model info refresh)
            draftModel = newValue
            initialModel = newValue
        }
        .onChange(of: draftProvider) { _, newProvider in
            if isCustomProviderEnabled {
                let defaultModel = store.dynamicProviderDefaultModel(newProvider)
                let fallback = store.dynamicProviderModels(newProvider).first?.id ?? ""
                draftModel = defaultModel.isEmpty ? fallback : defaultModel
            }
            apiKeyText = ""
        }
        .onChange(of: draftMode) { _, newMode in
            if newMode == "managed" && isCustomProviderEnabled {
                let anthropicModels = store.dynamicProviderModels("anthropic")
                let isCurrentModelAnthropic = anthropicModels.contains { $0.id == draftModel }
                if !isCurrentModelAnthropic {
                    let defaultModel = store.dynamicProviderDefaultModel("anthropic")
                    draftModel = defaultModel.isEmpty ? "claude-opus-4-6" : defaultModel
                }
            }
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

    // MARK: - Managed Login Prompt

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to use managed inference.")
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
            VButton(
                label: authManager.isSubmitting ? "Logging in..." : "Log In",
                style: .primary,
                isDisabled: authManager.isSubmitting
            ) {
                Task {
                    if let showToast {
                        await authManager.loginWithToast(showToast: showToast)
                    } else {
                        await authManager.startWorkOSLogin()
                    }
                }
            }
        }
    }

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
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
        let currentMask: String = {
            if isConnected, let masked = store.providerMaskedKeys[effectiveProvider], !masked.isEmpty {
                return masked
            }
            return ""
        }()
        let placeholder: String = {
            if !currentMask.isEmpty {
                return currentMask
            }
            if let providerPlaceholder = store.dynamicProviderApiKeyPlaceholder(effectiveProvider), !providerPlaceholder.isEmpty {
                return providerPlaceholder
            }
            return "Enter your API key"
        }()
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(isCustomProviderEnabled ? "\(providerDisplayName) API Key" : "API Key")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            SecureField(placeholder, text: $apiKeyText)
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .disabled(store.apiKeySaving)
                .frame(maxWidth: 400)

            if let error = store.apiKeySaveError {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
    }

    // MARK: - Model Picker

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Active Model")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            if isCustomProviderEnabled {
                providerModelPicker
            } else {
                defaultModelPicker
            }
        }
    }

    /// Anthropic-only model dropdown (flag off, backward compat).
    private var defaultModelPicker: some View {
        VDropdown(
            placeholder: "Select a model\u{2026}",
            selection: $draftModel,
            options: store.dynamicProviderModels("anthropic").map { model in
                (label: model.displayName, value: model.id)
            }
        )
    }

    /// Per-provider catalog model dropdown (flag on).
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

        // Persist mode if changed
        if draftMode != store.inferenceMode {
            store.setInferenceMode(draftMode)
        }

        // Persist provider if changed and flag is on
        let persistProvider = draftMode == "managed" ? "anthropic" : draftProvider
        if isCustomProviderEnabled && persistProvider != initialProvider {
            store.setInferenceProvider(persistProvider)
            initialProvider = persistProvider
        }

        // Persist API key if entered and in your-own mode.
        // saveAPIKey / saveInferenceAPIKey is async (validates with the provider before storing).
        // The key text is kept until validation succeeds so the user can retry.
        let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if draftMode == "your-own" && !trimmedKey.isEmpty {
            let keyTextBinding = $apiKeyText
            let displayName = providerDisplayName
            if isCustomProviderEnabled {
                store.saveInferenceAPIKey(trimmedKey, provider: effectiveProvider, onSuccess: {
                    keyTextBinding.wrappedValue = ""
                    showToast?("\(displayName) API key saved", .success)
                })
            } else {
                store.saveAPIKey(trimmedKey, onSuccess: {
                    keyTextBinding.wrappedValue = ""
                    showToast?("API key saved", .success)
                })
            }
        }

        // Persist model selection
        store.selectedModel = draftModel
        if isCustomProviderEnabled {
            let saveProvider = draftMode == "managed" ? "anthropic" : draftProvider
            store.setModel(draftModel, provider: saveProvider)
        } else {
            store.setModel(draftModel)
        }
        initialModel = draftModel
    }
}
