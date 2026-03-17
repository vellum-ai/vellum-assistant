import SwiftUI
import VellumAssistantShared

/// Card for the inference service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode and auth state:
/// - **Managed + logged in**: Model picker, Save button
/// - **Managed + not logged in**: Empty state prompting login
/// - **Your Own**: API key field, model picker, Save + Reset buttons
@MainActor
struct InferenceServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    @Binding var apiKeyText: String
    var showToast: ((String, ToastInfo.Style) -> Void)?

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"
    /// Snapshot of the model at card appear — used to detect model-only changes.
    @State private var initialModel: String = ""

    private var isConnected: Bool {
        store.hasKey
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
        let modeChanged = draftMode != store.inferenceMode
        let hasNewKey = !apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let modelChanged = store.selectedModel != initialModel
        return modeChanged || hasNewKey || modelChanged
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
                store.clearAPIKey()
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
                    // API Key field
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text("API Key")
                            .font(VFont.inputLabel)
                            .foregroundColor(VColor.contentSecondary)
                        SecureField(
                            isConnected && apiKeyText.isEmpty
                                ? "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••"
                                : "Enter your API key",
                            text: $apiKeyText
                        )
                        .vInputStyle()
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                        .disabled(store.apiKeySaving)

                        if let error = store.apiKeySaveError {
                            Text(error)
                                .font(VFont.caption)
                                .foregroundColor(VColor.systemNegativeStrong)
                        }
                    }

                    // Model picker
                    modelPicker
                }
            }
        )
        .onAppear {
            draftMode = store.inferenceMode
            initialModel = store.selectedModel
        }
        .onChange(of: store.inferenceMode) { _, newValue in
            // Sync draft when external changes arrive (e.g. daemon reload)
            draftMode = newValue
        }
    }

    // MARK: - Managed Login Prompt

    private var managedLoginPrompt: some View {
        VStack(spacing: VSpacing.md) {
            Text("In order to use the managed inference service, you must be logged in to Vellum.")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
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
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Model Picker

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Active Model")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a model\u{2026}",
                selection: Binding(
                    get: { store.selectedModel },
                    set: { store.selectedModel = $0 }
                ),
                options: SettingsStore.availableModels.map { model in
                    (label: SettingsStore.modelDisplayNames[model] ?? model, value: model)
                }
            )
        }
    }

    // MARK: - Save

    private func save() {
        store.apiKeySaveError = nil

        // Persist mode if changed
        if draftMode != store.inferenceMode {
            store.setInferenceMode(draftMode)
        }

        // Persist API key if entered and in your-own mode.
        // saveAPIKey is async (validates with the provider before storing).
        // The key text is kept until validation succeeds so the user can retry.
        let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if draftMode == "your-own" && !trimmedKey.isEmpty {
            let keyTextBinding = $apiKeyText
            store.saveAPIKey(trimmedKey, onSuccess: {
                keyTextBinding.wrappedValue = ""
            })
        }

        // Persist model selection
        store.setModel(store.selectedModel)
        initialModel = store.selectedModel
    }
}
