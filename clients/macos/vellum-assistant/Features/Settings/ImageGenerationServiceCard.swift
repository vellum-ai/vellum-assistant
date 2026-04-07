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

    private var isConnected: Bool {
        imageGenHasKey
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
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
                            store.clearImageGenKey()
                            imageGenHasKey = false
                            apiKeyText = ""
                        },
                        showReset: isConnected
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
            imageGenHasKey = await APIKeyManager.hasKey(for: "gemini")
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
                        if AppDelegate.shared?.isCurrentAssistantManaged ?? false {
                            AppDelegate.shared?.reconnectManagedAssistant()
                        }
                    })
                }
            }
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        let placeholder: String = {
            if isConnected {
                return "••••••••••••••••"
            }
            return "Enter your Gemini API key"
        }()
        return VTextField(
            "API Key",
            placeholder: placeholder,
            text: $apiKeyText,
            isSecure: true,
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
            store.saveImageGenKey(trimmedKey, onSuccess: { [self] in
                imageGenHasKey = true
                keyTextBinding.wrappedValue = ""
                showToast("Gemini API key saved", .success)
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
}
