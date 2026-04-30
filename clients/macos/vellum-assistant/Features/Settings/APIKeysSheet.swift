import SwiftUI
import VellumAssistantShared

/// Sheet for managing API keys across all key-required inference providers.
///
/// Each provider row shows its current key status (configured / not configured)
/// and expands inline to reveal an `APIKeyTextField` for entry. Keys are
/// validated and persisted individually via `store.saveInferenceAPIKey()`.
///
/// Opened from the "Manage API Keys..." button on `InferenceServiceCard`
/// when the inference-profiles feature flag is enabled.
@MainActor
struct APIKeysSheet: View {
    @ObservedObject var store: SettingsStore
    @Binding var isPresented: Bool
    var showToast: (String, ToastInfo.Style) -> Void

    /// Provider currently expanded for key entry. Only one provider can be
    /// expanded at a time to keep the UI focused.
    @State private var expandedProvider: String?

    /// Per-provider draft key text. Keyed by provider ID.
    @State private var keyTexts: [String: String] = [:]

    /// Per-provider error messages from validation failures.
    @State private var errors: [String: String] = [:]

    /// Per-provider saving state.
    @State private var saving: [String: Bool] = [:]

    /// Per-provider key-exists status. Loaded async on appear and after
    /// add/remove operations.
    @State private var keyStatuses: [String: Bool] = [:]

    /// Per-provider masked key previews (e.g. "sk-ant-•••Ab1x").
    @State private var maskedKeys: [String: String] = [:]

    /// Confirmation dialog state for key removal.
    @State private var providerToRemove: String?

    // MARK: - Computed

    /// Providers that require an API key, derived from the store's provider
    /// catalog. Excludes keyless providers like Ollama.
    private var keyRequiredProviders: [ProviderCatalogEntry] {
        store.providerCatalog.filter { $0.apiKeyPlaceholder != nil }
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            header
            SettingsDivider()
            providerList
            SettingsDivider()
            footer
        }
        .frame(width: 520, height: 480)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .task { await loadAllKeyStatuses() }
        .confirmationDialog(
            "Remove API Key",
            isPresented: Binding(
                get: { providerToRemove != nil },
                set: { if !$0 { providerToRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let provider = providerToRemove {
                Button("Remove", role: .destructive) {
                    removeKey(for: provider)
                }
                Button("Cancel", role: .cancel) {
                    providerToRemove = nil
                }
            }
        } message: {
            if let provider = providerToRemove {
                Text("Remove the \(store.dynamicProviderDisplayName(provider)) API key? Profiles using this provider will stop working until a new key is added.")
            }
        }
    }

    // MARK: - Header / Footer

    private var header: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Provider API Keys")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Text("Add API keys for the LLM providers you want to use.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            VButton(
                label: "Close",
                iconOnly: VIcon.x.rawValue,
                style: .ghost,
                tintColor: VColor.contentTertiary
            ) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    private var footer: some View {
        HStack {
            Spacer()
            VButton(label: "Done", style: .outlined) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Provider List

    private var providerList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(keyRequiredProviders, id: \.id) { provider in
                    providerRow(provider)
                    if provider.id != keyRequiredProviders.last?.id {
                        SettingsDivider()
                            .padding(.horizontal, VSpacing.lg)
                    }
                }
            }
            .padding(.vertical, VSpacing.sm)
        }
    }

    // MARK: - Provider Row

    private func providerRow(_ provider: ProviderCatalogEntry) -> some View {
        let isConfigured = keyStatuses[provider.id] == true
        let isExpanded = expandedProvider == provider.id
        let isSaving = saving[provider.id] == true

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Header: provider name + masked key + actions
            HStack(spacing: VSpacing.sm) {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(provider.displayName)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                    if isConfigured, !isExpanded, let masked = maskedKeys[provider.id] {
                        Text(masked)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }

                Spacer(minLength: 0)

                if isConfigured && !isExpanded {
                    HStack(spacing: VSpacing.sm) {
                        VTag("Connected", color: VColor.systemPositiveStrong, icon: .check)
                        VButton(label: "Update", style: .outlined, size: .compact) {
                            expandProvider(provider.id)
                        }
                        VButton(label: "Remove", style: .dangerOutline, size: .compact) {
                            providerToRemove = provider.id
                        }
                    }
                } else if !isConfigured && !isExpanded {
                    VButton(label: "Add Key", style: .outlined, size: .compact) {
                        expandProvider(provider.id)
                    }
                }
            }

            // Expanded: key entry form
            if isExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    APIKeyTextField(
                        label: "\(provider.displayName) API Key",
                        hasKey: isConfigured,
                        text: Binding(
                            get: { keyTexts[provider.id] ?? "" },
                            set: { keyTexts[provider.id] = $0 }
                        ),
                        emptyPlaceholder: provider.apiKeyPlaceholder ?? "Enter your API key",
                        errorMessage: errors[provider.id]
                    )
                    .disabled(isSaving)

                    HStack(spacing: VSpacing.sm) {
                        VButton(
                            label: isSaving ? "Validating..." : "Save Key",
                            style: .primary,
                            size: .compact,
                            isDisabled: (keyTexts[provider.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving
                        ) {
                            saveKey(for: provider.id)
                        }
                        VButton(label: "Cancel", style: .ghost, size: .compact) {
                            collapseProvider(provider.id)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .animation(VAnimation.fast, value: isExpanded)
    }

    // MARK: - Actions

    private func expandProvider(_ id: String) {
        keyTexts[id] = ""
        errors[id] = nil
        expandedProvider = id
    }

    private func collapseProvider(_ id: String) {
        keyTexts[id] = nil
        errors[id] = nil
        if expandedProvider == id {
            expandedProvider = nil
        }
    }

    private func saveKey(for providerId: String) {
        let text = keyTexts[providerId] ?? ""
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        saving[providerId] = true
        errors[providerId] = nil

        store.saveInferenceAPIKey(
            trimmed,
            provider: providerId,
            onSuccess: {
                saving[providerId] = false
                keyStatuses[providerId] = true
                keyTexts[providerId] = nil
                expandedProvider = nil
                showToast("\(store.dynamicProviderDisplayName(providerId)) API key saved", .success)
                // Refresh masked key
                Task { maskedKeys[providerId] = await APIKeyManager.maskedKey(for: providerId) }
            },
            onError: { error in
                saving[providerId] = false
                errors[providerId] = error
            }
        )
    }

    private func removeKey(for providerId: String) {
        store.clearAPIKeyForProvider(providerId)
        keyStatuses[providerId] = false
        maskedKeys[providerId] = nil
        if expandedProvider == providerId {
            expandedProvider = nil
        }
        showToast("\(store.dynamicProviderDisplayName(providerId)) API key removed", .success)
    }

    // MARK: - Key Status Loading

    private func loadAllKeyStatuses() async {
        for provider in keyRequiredProviders {
            let hasKey = await APIKeyManager.hasKey(for: provider.id)
            keyStatuses[provider.id] = hasKey
            if hasKey {
                maskedKeys[provider.id] = await APIKeyManager.maskedKey(for: provider.id)
            }
        }
    }
}
