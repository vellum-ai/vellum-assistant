import SwiftUI
import VellumAssistantShared

/// Card for configuring the web search provider (Anthropic, Perplexity, Brave).
///
/// Shows a provider dropdown and conditionally displays an API key field
/// when Perplexity or Brave is selected. Matches InferenceServiceCard styling.
@MainActor
struct WebSearchServiceCard: View {
    @ObservedObject var store: SettingsStore
    @Binding var perplexityKeyText: String
    @Binding var braveKeyText: String

    /// Snapshot of the provider at card appear — used to detect provider changes.
    @State private var initialProvider: String = ""

    private var isPerplexity: Bool {
        store.webSearchProvider == "perplexity"
    }

    private var isBrave: Bool {
        store.webSearchProvider == "brave"
    }

    private var needsAPIKey: Bool {
        isPerplexity || isBrave
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        let providerChanged = store.webSearchProvider != initialProvider
        let hasNewKey: Bool = {
            if isPerplexity {
                return !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            } else if isBrave {
                return !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return false
        }()
        return providerChanged || hasNewKey
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            header

            Divider()
                .background(VColor.borderBase)

            providerPicker

            if needsAPIKey {
                apiKeySection
            }

            actionButtons
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
        .onAppear {
            initialProvider = store.webSearchProvider
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Web Search")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)
            Text("Configure which web search provider to use for online research")
                .font(VFont.sectionDescription)
                .foregroundColor(VColor.contentTertiary)
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
                selection: Binding(
                    get: { store.webSearchProvider },
                    set: { store.setWebSearchProvider($0) }
                ),
                options: SettingsStore.availableWebSearchProviders.map { provider in
                    (label: SettingsStore.webSearchProviderDisplayNames[provider] ?? provider, value: provider)
                }
            )
        }
    }

    // MARK: - API Key Section

    private var apiKeySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("API Key")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            SecureField(
                apiKeyPlaceholder,
                text: isPerplexity ? $perplexityKeyText : $braveKeyText
            )
            .vInputStyle()
            .font(VFont.body)
            .foregroundColor(VColor.contentDefault)
        }
    }

    private var apiKeyPlaceholder: String {
        let isConnected = isPerplexity ? store.hasPerplexityKey : store.hasBraveKey
        let keyText = isPerplexity ? perplexityKeyText : braveKeyText
        let providerName = isPerplexity ? "Perplexity" : "Brave"
        if isConnected && keyText.isEmpty {
            return "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••"
        }
        return "Enter your \(providerName) API key"
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(label: "Save", style: .primary, isDisabled: !hasChanges) {
                save()
            }
            if needsAPIKey && (isPerplexity ? store.hasPerplexityKey : store.hasBraveKey) {
                VButton(label: "Reset", style: .danger) {
                    if isPerplexity {
                        store.clearPerplexityKey()
                    } else {
                        store.clearBraveKey()
                    }
                }
            }
        }
    }

    // MARK: - Save

    private func save() {
        // Always persist provider selection
        store.setWebSearchProvider(store.webSearchProvider)

        // Persist API key if entered for the current provider
        if isPerplexity && !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.savePerplexityKey(perplexityKeyText)
            perplexityKeyText = ""
        }
        if isBrave && !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.saveBraveKey(braveKeyText)
            braveKeyText = ""
        }

        // Update initial provider to reflect persisted state
        initialProvider = store.webSearchProvider
    }
}
