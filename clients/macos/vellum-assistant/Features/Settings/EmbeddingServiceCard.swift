import SwiftUI
import VellumAssistantShared

/// Card for embedding model configuration — no managed/your-own mode toggle.
///
/// Shows a provider dropdown, conditional API key field (for providers that
/// require one), optional model override, auto-resolved status, and degraded
/// warning.
@MainActor
struct EmbeddingServiceCard: View {
    @ObservedObject var store: SettingsStore
    @Binding var apiKeyText: String
    var showToast: (String, ToastInfo.Style) -> Void

    @State private var draftProvider: String = "auto"
    @State private var draftModel: String = ""
    @State private var initialProvider: String = ""
    @State private var initialModel: String = ""

    // MARK: - Fallback Provider List

    private static let fallbackProviders: [(label: String, value: String)] = [
        ("Auto (Best Available)", "auto"),
        ("Local (In-Process)", "local"),
        ("OpenAI", "openai"),
        ("Gemini", "gemini"),
        ("Ollama", "ollama"),
    ]

    // MARK: - Computed Helpers

    private var providerOptions: [(label: String, value: String)] {
        if store.embeddingAvailableProviders.isEmpty {
            return Self.fallbackProviders
        }
        return store.embeddingAvailableProviders.map { provider in
            (label: provider.displayName, value: provider.id)
        }
    }

    private var providerNeedsKey: Bool {
        draftProvider == "openai" || draftProvider == "gemini"
    }

    /// The default model for the currently selected provider, from the catalog.
    private var defaultModelForProvider: String {
        if let match = store.embeddingAvailableProviders.first(where: { $0.id == draftProvider }) {
            return match.defaultModel
        }
        return ""
    }

    /// Display name for the active (auto-resolved) provider.
    private var activeProviderDisplayName: String {
        guard let activeId = store.embeddingActiveProvider else { return "" }
        if let match = store.embeddingAvailableProviders.first(where: { $0.id == activeId }) {
            return match.displayName
        }
        // Fallback display names
        switch activeId {
        case "local": return "Local (In-Process)"
        case "openai": return "OpenAI"
        case "gemini": return "Gemini"
        case "ollama": return "Ollama"
        default: return activeId
        }
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        let providerChanged = draftProvider != initialProvider
        let modelChanged = draftModel != initialModel
        let hasNewKey = !apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return providerChanged || modelChanged || hasNewKey
    }

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            header

            Rectangle()
                .fill(VColor.surfaceBase)
                .frame(height: 1)

            // Provider picker
            providerPicker

            // Conditional API key field
            if providerNeedsKey {
                apiKeyField
            }

            // Conditional model field
            if draftProvider != "auto" {
                modelField
            }

            // Auto status label
            if draftProvider == "auto", let _ = store.embeddingActiveProvider {
                autoStatusLabel
            }

            // Degraded warning
            if store.embeddingDegraded {
                Text("Embedding service is degraded — semantic memory search may be unavailable.")
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.systemNegativeStrong)
            }

            // Action buttons
            actionButtons
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(radius: VRadius.xl, background: VColor.surfaceOverlay)
        .onAppear {
            draftProvider = store.embeddingProvider
            draftModel = store.embeddingModel ?? ""
            initialProvider = store.embeddingProvider
            initialModel = store.embeddingModel ?? ""
            store.refreshEmbeddingConfig()
        }
        .onChange(of: store.embeddingProvider) { _, newValue in
            draftProvider = newValue
            initialProvider = newValue
        }
        .onChange(of: store.embeddingModel) { _, newValue in
            draftModel = newValue ?? ""
            initialModel = newValue ?? ""
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Memory Embeddings")
                .font(VFont.titleSmall)
                .foregroundColor(VColor.contentDefault)
            Text("Configure which provider and model to use for semantic memory search")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundColor(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: Binding(
                    get: { draftProvider },
                    set: { newValue in
                        if newValue != draftProvider {
                            draftModel = ""
                            apiKeyText = ""
                        }
                        draftProvider = newValue
                    }
                ),
                options: providerOptions,
                maxWidth: 400
            )
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        let currentMask = store.maskedKeyForProvider(draftProvider)
        let placeholder: String = {
            if !currentMask.isEmpty {
                return currentMask
            }
            return "Enter your API key"
        }()
        return VTextField(
            "API Key",
            placeholder: placeholder,
            text: $apiKeyText,
            isSecure: true,
            errorMessage: store.embeddingKeySaveError,
            maxWidth: 400
        )
        .id("embedding-api-key-\(draftProvider)-\(placeholder)")
    }

    // MARK: - Model Field

    private var modelField: some View {
        VTextField(
            "Model",
            placeholder: defaultModelForProvider.isEmpty ? "Enter model name" : defaultModelForProvider,
            text: $draftModel,
            maxWidth: 400
        )
    }

    // MARK: - Auto Status Label

    private var autoStatusLabel: some View {
        let model = store.embeddingActiveModel ?? ""
        let display = activeProviderDisplayName
        let detail = model.isEmpty ? display : "\(display) (\(model))"
        return Text("Currently using: \(detail)")
            .font(VFont.labelDefault)
            .foregroundColor(VColor.contentTertiary)
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(
                label: "Save",
                style: .primary,
                isDisabled: !hasChanges
            ) {
                save()
            }

            if providerNeedsKey && store.hasKeyForProvider(draftProvider) {
                VButton(label: "Reset", style: .danger) {
                    store.clearAPIKeyForProvider(draftProvider)
                    apiKeyText = ""
                }
            }
        }
    }

    // MARK: - Save

    private func save() {
        // Persist API key if entered and provider needs one
        let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if providerNeedsKey && !trimmedKey.isEmpty {
            store.saveEmbeddingAPIKey(trimmedKey, provider: draftProvider)
            apiKeyText = ""
        }

        // Persist provider and/or model if changed
        if draftProvider != initialProvider || draftModel != initialModel {
            let modelToSave: String? = {
                let trimmed = draftModel.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty || trimmed == defaultModelForProvider {
                    return nil
                }
                return trimmed
            }()
            store.setEmbeddingProvider(draftProvider, model: modelToSave)
        }

        initialProvider = draftProvider
        initialModel = draftModel
    }
}
