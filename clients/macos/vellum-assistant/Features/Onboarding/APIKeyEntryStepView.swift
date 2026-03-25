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
    @FocusState private var keyFieldFocused: Bool

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
        Text("Connect a Model Provider")
            .font(.system(size: 32, weight: .regular, design: .serif))
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.md)

        Text("Enter an API key to connect your model provider.")
            .font(VFont.titleSmall)
            .multilineTextAlignment(.center)
            .foregroundStyle(VColor.contentSecondary)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        VStack(spacing: VSpacing.md) {
            VStack(spacing: VSpacing.md) {
                providerPicker

                if providerRequiresKey {
                    apiKeyField
                }

                VButton(label: "Continue", style: .primary, isFullWidth: true, isDisabled: providerRequiresKey && apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    saveAndHatch()
                }

                if let apiKeyUrl = currentProviderEntry?.apiKeyUrl,
                   let url = URL(string: apiKeyUrl) {
                    VButton(label: "Get an API key", style: .ghost) {
                        NSWorkspace.shared.open(url)
                    }
                }

                VButton(label: "Back", style: .ghost) {
                    goBack()
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            if let existingKey = APIKeyManager.getKey(for: state.selectedProvider) {
                apiKey = existingKey
                hasExistingKey = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.1)) {
                showTitle = true
            }
            withAnimation(.easeOut(duration: 0.5).delay(0.3)) {
                showContent = true
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 800_000_000)
                guard !Task.isCancelled else { return }
                keyFieldFocused = true
            }
        }
        .onChange(of: state.selectedProvider) { _, newProvider in
            if let entry = providerCatalog.first(where: { $0.id == newProvider }) {
                state.selectedModel = entry.defaultModel
            }
            if let existingKey = APIKeyManager.getKey(for: newProvider) {
                apiKey = existingKey
                hasExistingKey = true
                isEditing = false
            } else {
                apiKey = ""
                hasExistingKey = false
                isEditing = false
            }
        }
    }

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $state.selectedProvider,
                options: providerCatalog.map { entry in
                    (label: entry.displayName, value: entry.id)
                }
            )
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        Group {
            if hasExistingKey && !isEditing {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("\(providerDisplayName) API Key")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(maskedKey)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDefault)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .frame(height: 32)
                        .vInputChrome()
                        .onTapGesture {
                            isEditing = true
                            Task { @MainActor in
                                try? await Task.sleep(nanoseconds: 100_000_000)
                                guard !Task.isCancelled else { return }
                                keyFieldFocused = true
                            }
                        }
                }
            } else {
                VTextField(
                    "\(providerDisplayName) API Key",
                    placeholder: currentProviderEntry?.apiKeyPlaceholder ?? "Enter your API key",
                    text: $apiKey,
                    isSecure: true,
                    onSubmit: {
                        guard !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                        saveAndHatch()
                    },
                    isFocused: $keyFieldFocused
                )
            }
        }
        .frame(maxWidth: .infinity)
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
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !providerRequiresKey || !trimmed.isEmpty else { return }
        if providerRequiresKey {
            APIKeyManager.setKey(trimmed, for: state.selectedProvider)
        }
        state.advance()
    }
}
