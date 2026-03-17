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
        let modeChanged = draftMode != store.inferenceMode
        let hasNewKey = !apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let modelChanged = store.selectedModel != initialModel
        return modeChanged || hasNewKey || modelChanged
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Header: title + subtitle + mode toggle
            header

            Divider()
                .background(VColor.borderBase)

            // Mode-specific content
            if draftMode == "managed" {
                managedContent
            } else {
                yourOwnContent
            }

            // Action buttons
            actionButtons
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
        .onAppear {
            draftMode = store.inferenceMode
            initialModel = store.selectedModel
        }
        .onChange(of: store.inferenceMode) { _, newValue in
            // Sync draft when external changes arrive (e.g. daemon reload)
            draftMode = newValue
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Text("Inference")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                VSegmentedControl(
                    items: [
                        (label: "Managed", tag: "managed"),
                        (label: "Your Own", tag: "your-own"),
                    ],
                    selection: $draftMode,
                    style: .pill
                )
                .frame(width: 220)
            }
            Text("Configure which LLM provider and model to use to power your assistant")
                .font(VFont.sectionDescription)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    // MARK: - Managed Content

    private var managedContent: some View {
        Group {
            if isLoggedIn {
                modelPicker
            } else {
                managedLoginPrompt
            }
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
                    await authManager.startWorkOSLogin()
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    // MARK: - Your Own Content

    private var yourOwnContent: some View {
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
            }

            // Model picker
            modelPicker
        }
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
            .frame(width: 400)
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            if draftMode == "managed" && !isLoggedIn {
                EmptyView()
            } else {
                VButton(label: "Save", style: .primary, isDisabled: !hasChanges) {
                    save()
                }
                if draftMode == "your-own" && isConnected {
                    VButton(label: "Reset", style: .danger) {
                        store.clearAPIKey()
                        apiKeyText = ""
                    }
                }
            }
        }
    }

    // MARK: - Save

    private func save() {
        // Persist mode if changed
        if draftMode != store.inferenceMode {
            store.setInferenceMode(draftMode)
        }

        // Persist API key if entered and in your-own mode
        let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if draftMode == "your-own" && !trimmedKey.isEmpty {
            store.saveAPIKey(trimmedKey)
            apiKeyText = ""
        }

        // Persist model selection
        store.setModel(store.selectedModel)
        initialModel = store.selectedModel
    }
}
