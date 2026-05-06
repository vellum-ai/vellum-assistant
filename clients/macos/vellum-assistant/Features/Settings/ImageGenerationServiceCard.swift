import SwiftUI
import VellumAssistantShared

/// Card for the image generation service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode and auth state:
/// - **Managed + logged in**: Model picker, Save button
/// - **Managed + not logged in**: Empty state prompting login
/// - **Your Own**: Gemini API key field, model picker, Save + Reset buttons
@MainActor
struct ImageGenerationServiceCard: View {
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
    /// Whether the image generation provider has a stored API key (fetched per-component).
    @State private var imageGenHasKey = false
    /// In-flight `APIKeyManager.hasKey` lookup — tracked so rapid provider switches
    /// can cancel stale responses before they overwrite the current provider's state.
    @State private var hasKeyTask: Task<Void, Never>?

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    /// The API-key provider associated with the currently-selected draft model.
    /// Flips between `"gemini"` and `"openai"` as the user switches models in the picker.
    private var currentProvider: String {
        SettingsStore.imageGenProvider(forModel: draftModel)
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        // In managed mode when not logged in, there is nothing actionable to save.
        if draftMode == "managed" && !isLoggedIn {
            return false
        }
        let modeChanged = draftMode != store.imageGenMode
        let hasNewKey = !apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let modelChanged = draftModel != initialModel
        return modeChanged || hasNewKey || modelChanged
    }

    var body: some View {
        ServiceModeCard(
            title: "Image Generation",
            subtitle: "Configure which model your assistant uses to generate images",
            draftMode: $draftMode,
            managedContent: {
                if isLoggedIn {
                    PickerWithInlineSave(
                        hasChanges: hasChanges,
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
                    // API Key field
                    apiKeyField

                    // Model picker
                    modelPicker

                    // Action buttons
                    ServiceCardActions(
                        hasChanges: hasChanges,
                        isSaving: store.imageGenKeySaving,
                        onSave: { save() },
                        savingLabel: "Validating...",
                        onReset: {
                            store.clearImageGenKey(for: currentProvider)
                            imageGenHasKey = false
                            apiKeyText = ""
                        },
                        showReset: imageGenHasKey
                    )
                }
            }
        )
        .onAppear {
            draftMode = store.imageGenMode
            draftModel = store.selectedImageGenModel
            initialModel = store.selectedImageGenModel
        }
        .task {
            await refreshHasKey(for: currentProvider)
        }
        .onChange(of: draftModel) { oldValue, newValue in
            // When the user picks a model whose provider differs from the previous
            // selection (e.g. a Gemini model → an OpenAI model), clear any typed
            // API-key text. Without this, a partially-typed Gemini key could be
            // submitted under the openai credential slot (or vice versa) if the
            // user switches models before hitting Save. Clearing only on actual
            // provider change avoids disrupting in-flight typing when the user
            // just switches between two models of the same provider.
            let oldProvider = SettingsStore.imageGenProvider(forModel: oldValue)
            let newProvider = SettingsStore.imageGenProvider(forModel: newValue)
            if oldProvider != newProvider {
                apiKeyText = ""
            }
            // Re-fetch the "key configured" indicator when the user switches between
            // Gemini and OpenAI models in the picker so the UI reflects the right provider.
            // Cancel any in-flight lookup so a slow prior-provider response can't
            // overwrite state for the current provider (hasKey has a 5s network timeout).
            hasKeyTask?.cancel()
            let targetProvider = newProvider
            hasKeyTask = Task {
                await refreshHasKey(for: targetProvider)
            }
        }
        .onChange(of: store.imageGenMode) { _, newValue in
            // Sync draft when external changes arrive (e.g. daemon reload)
            draftMode = newValue
        }
        .onChange(of: store.selectedImageGenModel) { _, newValue in
            // Sync draft & baseline when external changes arrive (e.g. daemon model info refresh)
            draftModel = newValue
            initialModel = newValue
        }
    }

    // MARK: - Managed Login Prompt

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to use managed image generation.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
            VButton(
                label: authManager.isSubmitting ? "Logging in..." : "Log In",
                style: .primary,
                isDisabled: authManager.isSubmitting
            ) {
                Task {
                    await authManager.loginWithToast(showToast: showToast, onSuccess: {
                        AppDelegate.shared?.handlePlatformLoginSucceeded()
                    })
                }
            }
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        APIKeyTextField(
            label: "API Key",
            hasKey: imageGenHasKey,
            text: $apiKeyText,
            emptyPlaceholder: currentProvider == "openai" ? "Enter your OpenAI API key" : "Enter your Gemini API key",
            errorMessage: store.imageGenKeySaveError
        )
        .disabled(store.imageGenKeySaving)
    }

    // MARK: - Model Picker

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Active Model")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a model\u{2026}",
                selection: $draftModel,
                options: SettingsStore.availableImageGenModels.map { model in
                    (label: SettingsStore.imageGenModelDisplayNames[model] ?? model, value: model)
                }
            )
        }
    }

    // MARK: - Save

    private func save() {
        // Persist API key if entered and in your-own mode.
        // saveImageGenKey is async (validates with the provider before storing).
        // The key text is kept until validation succeeds so the user can retry.
        let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if draftMode == "your-own" && !trimmedKey.isEmpty {
            let keyTextBinding = $apiKeyText
            let provider = currentProvider
            store.saveImageGenKey(trimmedKey, for: provider, onSuccess: { [self] in
                // Validation can take seconds; the user may have switched providers
                // while it ran. Only flip the indicator directly when the save-time
                // provider still matches the card's current provider — otherwise
                // re-query so the displayed state reflects the now-visible provider.
                if provider == currentProvider {
                    imageGenHasKey = true
                    keyTextBinding.wrappedValue = ""
                } else {
                    hasKeyTask?.cancel()
                    let targetProvider = currentProvider
                    hasKeyTask = Task {
                        await refreshHasKey(for: targetProvider)
                    }
                }
                showToast("\(provider == "openai" ? "OpenAI" : "Gemini") API key saved", .success)
            })
        }

        let modeChanged = draftMode != store.imageGenMode
        let pendingMode = modeChanged ? store.setImageGenMode(draftMode) : nil

        // Await the mode patch before writing the model so the daemon's
        // read-modify-write cycle for the model doesn't overwrite the mode.
        let capturedModel = draftModel
        Task {
            if let pendingMode { _ = await pendingMode.value }
            store.setImageGenModel(capturedModel)
        }
        initialModel = draftModel
    }

    /// Fetch `hasKey` for `provider` and write the result only if the card's
    /// current provider still matches. Guards against stale responses from a
    /// prior provider arriving after the user has already switched.
    private func refreshHasKey(for provider: String) async {
        let result = await APIKeyManager.hasKey(for: provider)
        if Task.isCancelled { return }
        if provider == currentProvider {
            imageGenHasKey = result
        }
    }
}
