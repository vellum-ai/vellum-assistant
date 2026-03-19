import VellumAssistantShared
import SwiftUI

@MainActor
struct APIKeyEntryStepView: View {
    @Bindable var state: OnboardingState

    @State private var apiKey: String = ""
    @State private var hasExistingKey = false
    @State private var isEditing = false
    @State private var showTitle = false
    @State private var showContent = false
    @State private var selectedModel: String = "claude-opus-4-6"
    @FocusState private var keyFieldFocused: Bool

    // MARK: - Feature Flag

    private var isCustomProviderEnabled: Bool {
        MacOSClientFeatureFlagManager.shared.isEnabled("custom_inference_provider_enabled")
    }

    // MARK: - Provider Catalog

    private var providerCatalog: [ProviderCatalogEntry] {
        return [
            ProviderCatalogEntry(id: "anthropic", displayName: "Anthropic", models: [
                CatalogModel(id: "claude-opus-4-6", displayName: "Claude Opus 4.6"),
                CatalogModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                CatalogModel(id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5"),
            ], defaultModel: "claude-opus-4-6", apiKeyUrl: "https://console.anthropic.com/settings/keys", apiKeyPlaceholder: "sk-ant-api03-..."),
            ProviderCatalogEntry(id: "openai", displayName: "OpenAI", models: [
                CatalogModel(id: "gpt-5.4", displayName: "GPT-5.4"),
                CatalogModel(id: "gpt-5.2", displayName: "GPT-5.2"),
                CatalogModel(id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini"),
                CatalogModel(id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano"),
            ], defaultModel: "gpt-5.4", apiKeyUrl: "https://platform.openai.com/api-keys", apiKeyPlaceholder: "sk-proj-..."),
            ProviderCatalogEntry(id: "gemini", displayName: "Google Gemini", models: [
                CatalogModel(id: "gemini-3-flash", displayName: "Gemini 3 Flash"),
                CatalogModel(id: "gemini-3-pro", displayName: "Gemini 3 Pro"),
            ], defaultModel: "gemini-3-flash", apiKeyUrl: "https://aistudio.google.com/apikey", apiKeyPlaceholder: "AIza..."),
            ProviderCatalogEntry(id: "ollama", displayName: "Ollama", models: [
                CatalogModel(id: "llama3.2", displayName: "Llama 3.2"),
                CatalogModel(id: "mistral", displayName: "Mistral"),
            ], defaultModel: "llama3.2"),
            ProviderCatalogEntry(id: "fireworks", displayName: "Fireworks", models: [
                CatalogModel(id: "accounts/fireworks/models/kimi-k2p5", displayName: "Kimi K2.5"),
            ], defaultModel: "accounts/fireworks/models/kimi-k2p5", apiKeyUrl: "https://fireworks.ai/account/api-keys", apiKeyPlaceholder: "fw_..."),
            ProviderCatalogEntry(id: "openrouter", displayName: "OpenRouter", models: [
                CatalogModel(id: "x-ai/grok-4", displayName: "Grok 4"),
                CatalogModel(id: "x-ai/grok-4.20-beta", displayName: "Grok 4.20 Beta"),
            ], defaultModel: "x-ai/grok-4", apiKeyUrl: "https://openrouter.ai/keys", apiKeyPlaceholder: "sk-or-v1-..."),
        ]
    }

    // MARK: - Provider Helpers

    private var currentProviderEntry: ProviderCatalogEntry? {
        providerCatalog.first { $0.id == state.selectedProvider }
    }

    private var providerDisplayName: String {
        currentProviderEntry?.displayName ?? state.selectedProvider
    }

    private var providerRequiresKey: Bool {
        state.selectedProvider != "ollama"
    }

    // MARK: - Body

    var body: some View {
        Text(isCustomProviderEnabled ? "Connect a Model Provider" : "Anthropic API Key")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundColor(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text(isCustomProviderEnabled
            ? "Enter an API key to connect your model provider."
            : "Enter your Anthropic API key to get started.")
            .font(VFont.buttonLarge)
            .multilineTextAlignment(.center)
            .foregroundColor(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                if isCustomProviderEnabled {
                    providerPicker

                    if providerRequiresKey {
                        apiKeyField
                    }

                    modelPicker

                    OnboardingButton(
                        title: "Continue",
                        style: .primary,
                        disabled: providerRequiresKey && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        saveAndHatch()
                    }

                    if let apiKeyUrl = currentProviderEntry?.apiKeyUrl,
                       let url = URL(string: apiKeyUrl) {
                        OnboardingButton(title: "Get an API key", style: .ghostPrimary) {
                            NSWorkspace.shared.open(url)
                        }
                    }

                    OnboardingButton(title: "Back", style: .ghost) {
                        goBack()
                    }
                } else {
                    apiKeyField

                    OnboardingButton(
                        title: "Continue",
                        style: .primary,
                        disabled: apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ) {
                        saveAndHatch()
                    }

                    OnboardingButton(title: "Get an API key", style: .ghostPrimary) {
                        NSWorkspace.shared.open(URL(string: "https://console.anthropic.com/settings/keys")!)
                    }

                    OnboardingButton(title: "Back", style: .ghost) {
                        goBack()
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            if isCustomProviderEnabled {
                if let existingKey = APIKeyManager.getKey(for: state.selectedProvider) {
                    apiKey = existingKey
                    hasExistingKey = true
                }
            } else {
                if let existingKey = APIKeyManager.getKey(for: "anthropic") {
                    apiKey = existingKey
                    hasExistingKey = true
                }
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                keyFieldFocused = true
            }
        }
        .onChange(of: state.selectedProvider) { _, newProvider in
            if let entry = providerCatalog.first(where: { $0.id == newProvider }) {
                selectedModel = entry.defaultModel
            }
            apiKey = ""
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
                selection: $state.selectedProvider,
                options: providerCatalog.map { entry in
                    (label: entry.displayName, value: entry.id)
                }
            )
        }
    }

    // MARK: - Model Picker

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Model")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a model\u{2026}",
                selection: $selectedModel,
                options: (currentProviderEntry?.models ?? []).map { model in
                    (label: model.displayName, value: model.id)
                }
            )
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        Group {
            if hasExistingKey && !isEditing {
                Text(maskedKey)
                    .font(.system(size: 16, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .onTapGesture {
                        isEditing = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            keyFieldFocused = true
                        }
                    }
            } else {
                SecureField(
                    currentProviderEntry?.apiKeyPlaceholder ?? "Enter your API key",
                    text: $apiKey
                )
                    .textFieldStyle(.plain)
                    .font(.system(size: 16, weight: .medium, design: .monospaced))
                    .foregroundColor(VColor.contentDefault)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.vertical, VSpacing.lg)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .focused($keyFieldFocused)
                    .onSubmit {
                        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        saveAndHatch()
                    }
            }
        }
    }

    // MARK: - Helpers

    private var maskedKey: String {
        guard apiKey.count > 7 else { return String(repeating: "\u{2022}", count: apiKey.count) }
        let prefix = String(apiKey.prefix(4))
        let suffix = String(apiKey.suffix(3))
        let dots = String(repeating: "\u{2022}", count: min(apiKey.count - 7, 20))
        return prefix + dots + suffix
    }

    private func goBack() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            state.currentStep -= 1
        }
    }

    private func saveAndHatch() {
        if isCustomProviderEnabled {
            let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !providerRequiresKey || !trimmed.isEmpty else { return }
            if providerRequiresKey {
                APIKeyManager.setKey(trimmed, for: state.selectedProvider)
            }
            WorkspaceConfigIO.initializeServiceDefaults(defaultMode: "your-own")
            // Persist provider + model
            let existingConfig = WorkspaceConfigIO.read()
            var services = existingConfig["services"] as? [String: Any] ?? [:]
            var inference = services["inference"] as? [String: Any] ?? [:]
            inference["provider"] = state.selectedProvider
            inference["model"] = selectedModel
            services["inference"] = inference
            try? WorkspaceConfigIO.merge(["services": services])
            state.advance()
        } else {
            let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            APIKeyManager.setKey(trimmed, for: "anthropic")

            // Set service modes to "your-own" for any services that don't already
            // have a mode configured (first-time BYOK onboarding).
            WorkspaceConfigIO.initializeServiceDefaults(defaultMode: "your-own")

            saveModelToConfig("claude-opus-4-6")
            state.advance()
        }
    }

    private func saveModelToConfig(_ model: String) {
        let existingConfig = WorkspaceConfigIO.read()
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var inference = services["inference"] as? [String: Any] ?? [:]
        inference["model"] = model
        services["inference"] = inference
        try? WorkspaceConfigIO.merge(["services": services])
    }
}
