#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Settings section for managing API keys and the active LLM model.
struct ModelsServicesSection: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @State private var currentModel: String?
    @State private var modelInput: String = ""
    @State private var selectedProvider: APIKeyProvider?
    @State private var loading = false

    /// The two API key providers currently supported by `APIKeyManager`.
    private let providers: [APIKeyProvider] = [
        APIKeyProvider(id: "anthropic", displayName: "Claude (Anthropic)"),
        APIKeyProvider(id: "elevenlabs", displayName: "ElevenLabs"),
    ]

    var body: some View {
        Form {
            // MARK: - Model Selection

            Section {
                if loading {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                } else if let model = currentModel {
                    LabeledContent("Active Model", value: model)
                } else {
                    Text("Not connected")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                }

                HStack {
                    TextField("Model ID", text: $modelInput)
                        .textContentType(.none)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                    Button("Set") {
                        let trimmed = modelInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        setModel(trimmed)
                    }
                    .disabled(modelInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } header: {
                Text("Model")
            } footer: {
                Text("The model ID used by the assistant for text generation (e.g. claude-sonnet-4-20250514).")
            }

            // MARK: - API Key Providers

            Section {
                ForEach(providers) { provider in
                    providerRow(provider)
                }
            } header: {
                Text("API Keys")
            } footer: {
                Text("Keys are stored securely in the iOS Keychain and never sent to Vellum servers.")
            }
        }
        .navigationTitle("Models & Services")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { fetchModel() }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { fetchModel() }
        }
        .sheet(item: $selectedProvider) { provider in
            APIKeyDetailSheet(provider: provider)
        }
    }

    // MARK: - Provider Row

    @ViewBuilder
    private func providerRow(_ provider: APIKeyProvider) -> some View {
        let hasKey = APIKeyManager.shared.getAPIKey(provider: provider.id) != nil
        Button {
            selectedProvider = provider
        } label: {
            HStack {
                Text(provider.displayName)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                VIconView(hasKey ? .circleCheck : .info, size: 14)
                    .foregroundColor(hasKey ? VColor.systemPositiveStrong : VColor.contentTertiary)
            }
        }
        .accessibilityLabel("\(provider.displayName), \(hasKey ? "key saved" : "no key set")")
        .accessibilityHint("Opens API key management")
    }

    // MARK: - Model Communication

    private let settingsClient = SettingsClient()

    private func fetchModel() {
        loading = true
        Task {
            let info = await settingsClient.fetchModelInfo()
            currentModel = info?.model
            loading = false
        }
    }

    private func setModel(_ model: String) {
        loading = true
        Task {
            let info = await settingsClient.setModel(model: model)
            if let info {
                currentModel = info.model
                modelInput = ""
            }
            loading = false
        }
    }
}

// MARK: - Supporting Types

struct APIKeyProvider: Identifiable {
    let id: String
    let displayName: String
}

// MARK: - API Key Detail Sheet

private struct APIKeyDetailSheet: View {
    let provider: APIKeyProvider
    @Environment(\.dismiss) private var dismiss
    @State private var keyText: String = ""
    @State private var hasExistingKey: Bool = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if hasExistingKey {
                        HStack {
                            VIconView(.circleCheck, size: 16)
                                .foregroundColor(VColor.systemPositiveStrong)
                            Text("API key saved")
                            Spacer()
                        }
                    } else {
                        SecureField("API Key", text: $keyText)
                            .textContentType(.password)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                    }
                } header: {
                    Text(provider.displayName)
                }

                Section {
                    if hasExistingKey {
                        Button("Clear Key", role: .destructive) {
                            _ = APIKeyManager.shared.deleteAPIKey(provider: provider.id)
                            hasExistingKey = false
                            keyText = ""
                        }
                    } else {
                        Button("Save") {
                            let trimmed = keyText.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !trimmed.isEmpty else { return }
                            _ = APIKeyManager.shared.setAPIKey(trimmed, provider: provider.id)
                            hasExistingKey = true
                            keyText = ""
                        }
                        .disabled(keyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .navigationTitle(provider.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                hasExistingKey = APIKeyManager.shared.getAPIKey(provider: provider.id) != nil
            }
        }
    }
}
#endif
