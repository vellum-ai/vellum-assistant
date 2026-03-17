import SwiftUI
import VellumAssistantShared

/// Card for the web search service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode, inference mode, and auth state:
/// - **Managed + Managed inference + logged in**: Message that web search is included.
/// - **Managed + Managed inference + not logged in**: Login prompt.
/// - **Managed + Your Own inference**: Message that managed web search is not yet available.
/// - **Your Own + Your Own inference**: Provider picker (Provider Native, Perplexity, Brave) + API key.
/// - **Your Own + Managed inference**: Provider picker (Perplexity, Brave only) + API key.
@MainActor
struct WebSearchServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    @Binding var perplexityKeyText: String
    @Binding var braveKeyText: String
    var showToast: ((String, ToastInfo.Style) -> Void)?

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"
    /// Local draft of the provider selection — only persisted on Save.
    @State private var draftProvider: String = "inference-provider-native"
    /// Snapshot of the provider at card appear — used to detect provider changes.
    @State private var initialProvider: String = ""

    private var isPerplexity: Bool {
        draftProvider == "perplexity"
    }

    private var isBrave: Bool {
        draftProvider == "brave"
    }

    private var needsAPIKey: Bool {
        isPerplexity || isBrave
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    /// The available providers depend on the current inference mode.
    /// Provider Native requires Your Own inference (it uses the user's own API key).
    private var availableProviders: [String] {
        store.inferenceMode == "your-own"
            ? ["inference-provider-native", "perplexity", "brave"]
            : ["perplexity", "brave"]
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        if draftMode == "managed" {
            // Managed + Your Own inference: managed web search is not yet available.
            if store.inferenceMode == "your-own" {
                return false
            }
            // Managed + Managed inference but not logged in: nothing actionable.
            if !isLoggedIn {
                return false
            }
            // Managed + Managed inference + logged in: only mode change matters.
            return draftMode != store.webSearchMode
        }

        // Your Own mode: detect mode, provider, and API key changes.
        let modeChanged = draftMode != store.webSearchMode
        let providerChanged = draftProvider != initialProvider
        let hasNewKey: Bool = {
            if isPerplexity {
                return !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            } else if isBrave {
                return !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            return false
        }()
        return modeChanged || providerChanged || hasNewKey
    }

    var body: some View {
        ServiceModeCard(
            title: "Web Search",
            subtitle: "Configure which web search provider to use for online research",
            draftMode: $draftMode,
            hasChanges: hasChanges,
            isSaving: false,
            onSave: { save() },
            onReset: {
                if isPerplexity {
                    store.clearPerplexityKey()
                    perplexityKeyText = ""
                } else if isBrave {
                    store.clearBraveKey()
                    braveKeyText = ""
                }
            },
            showReset: draftMode == "your-own" && needsAPIKey
                && (isPerplexity ? store.hasPerplexityKey : store.hasBraveKey),
            managedContent: {
                if store.inferenceMode == "your-own" {
                    managedUnavailableMessage
                } else if isLoggedIn {
                    managedIncludedMessage
                } else {
                    managedLoginPrompt
                }
            },
            yourOwnContent: {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    providerPicker

                    if needsAPIKey {
                        apiKeySection
                    }
                }
            }
        )
        .onAppear {
            draftMode = store.webSearchMode
            draftProvider = store.webSearchProvider
            initialProvider = store.webSearchProvider
        }
        .onChange(of: store.webSearchMode) { _, newValue in
            draftMode = newValue
        }
        .onChange(of: store.webSearchProvider) { _, newValue in
            draftProvider = newValue
            initialProvider = newValue
        }
        .onChange(of: store.inferenceMode) { _, newValue in
            // Auto-correct invalid states when inference mode changes.
            if newValue == "your-own" && draftMode == "managed" {
                // Managed web search is not yet available without managed inference.
                draftMode = "your-own"
            }
            if newValue == "managed" && draftProvider == "inference-provider-native" {
                // Provider Native requires Your Own inference.
                draftProvider = "perplexity"
            }
        }
    }

    // MARK: - Managed Content

    private var managedIncludedMessage: some View {
        VStack(spacing: VSpacing.md) {
            Text("Web search is included with managed inference.")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    private var managedUnavailableMessage: some View {
        VStack(spacing: VSpacing.md) {
            Text("Managed web search is not yet available when using your own inference provider.")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    private var managedLoginPrompt: some View {
        VStack(spacing: VSpacing.md) {
            Text("In order to use the managed web search service, you must be logged in to Vellum.")
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

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $draftProvider,
                options: availableProviders.map { provider in
                    (label: SettingsStore.webSearchProviderDisplayNames[provider] ?? provider, value: provider)
                }
            )
        }
    }

    // MARK: - API Key Section

    private var apiKeySection: some View {
        let hasKey = isPerplexity ? store.hasPerplexityKey : store.hasBraveKey
        let keyText = isPerplexity ? perplexityKeyText : braveKeyText

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("API Key")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            SecureField(
                "Enter your API key",
                text: isPerplexity ? $perplexityKeyText : $braveKeyText
            )
            .vInputStyle()
            .font(VFont.body)
            .foregroundColor(VColor.contentDefault)

            if hasKey && keyText.isEmpty {
                Label("Key saved", systemImage: "checkmark.circle.fill")
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemPositiveStrong)
            }
        }
    }

    // MARK: - Save

    private func save() {
        // Persist mode if changed
        if draftMode != store.webSearchMode {
            store.setWebSearchMode(draftMode)
        }

        // In your-own mode, persist provider and API keys.
        if draftMode == "your-own" {
            store.setWebSearchProvider(draftProvider)

            if isPerplexity && !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                store.savePerplexityKey(perplexityKeyText)
                perplexityKeyText = ""
            }
            if isBrave && !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                store.saveBraveKey(braveKeyText)
                braveKeyText = ""
            }
        }

        // Update initial provider to reflect persisted state
        initialProvider = draftProvider
    }
}
