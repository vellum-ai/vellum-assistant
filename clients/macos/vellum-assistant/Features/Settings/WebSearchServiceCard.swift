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
    var showToast: (String, ToastInfo.Style) -> Void

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"
    /// Local draft of the provider selection — only persisted on Save.
    @State private var draftProvider: String = "inference-provider-native"
    /// Snapshot of the provider at card appear — used to detect provider changes.
    @State private var initialProvider: String = ""
    /// Whether the Perplexity provider has a stored API key (fetched per-component).
    @State private var perplexityHasKey = false
    /// Whether the Brave provider has a stored API key (fetched per-component).
    @State private var braveHasKey = false

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
            subtitle: "Configure how your assistant should search the web",
            draftMode: $draftMode,
            managedContent: {
                if store.inferenceMode == "your-own" {
                    managedUnavailableMessage
                } else if isLoggedIn {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        managedIncludedMessage
                        if hasChanges {
                            ServiceCardActions(hasChanges: hasChanges, onSave: { save() })
                        }
                    }
                } else {
                    managedLoginPrompt
                }
            },
            yourOwnContent: {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    if needsAPIKey {
                        providerPicker
                        apiKeySection

                        ServiceCardActions(
                            hasChanges: hasChanges,
                            onSave: { save() },
                            onReset: {
                                if isPerplexity {
                                    store.clearPerplexityKey()
                                    perplexityHasKey = false
                                    perplexityKeyText = ""
                                } else if isBrave {
                                    store.clearBraveKey()
                                    braveHasKey = false
                                    braveKeyText = ""
                                }
                            },
                            showReset: isPerplexity ? perplexityHasKey : braveHasKey
                        )
                    } else {
                        PickerWithInlineSave(
                            hasChanges: hasChanges,
                            onSave: { save() }
                        ) {
                            providerPicker
                        }
                    }
                }
            }
        )
        .onAppear {
            draftMode = store.webSearchMode
            draftProvider = store.webSearchProvider
            initialProvider = store.webSearchProvider
        }
        .task {
            perplexityHasKey = await APIKeyManager.hasKey(for: "perplexity")
            braveHasKey = await APIKeyManager.hasKey(for: "brave")
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
        Text("Web search is included with managed inference.")
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentDefault)
    }

    private var managedUnavailableMessage: some View {
        Text("Managed web search requires managed inference.")
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentDefault)
    }

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to use managed web search.")
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

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
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
        VTextField(
            "API Key",
            placeholder: "Enter your API key",
            text: isPerplexity ? $perplexityKeyText : $braveKeyText,
            isSecure: true,
            errorMessage: isPerplexity ? store.perplexityKeySaveError : store.braveKeySaveError,
            maxWidth: 400
        )
    }

    // MARK: - Save

    private func save() {
        let modeChanged = draftMode != store.webSearchMode
        let pendingMode = modeChanged ? store.setWebSearchMode(draftMode) : nil

        // In your-own mode, persist provider and API keys.
        if draftMode == "your-own" {
            // Await the mode patch before writing the provider so the
            // daemon's read-modify-write cycle doesn't overwrite the mode.
            let capturedProvider = draftProvider
            Task {
                if let pendingMode { _ = await pendingMode.value }
                store.setWebSearchProvider(capturedProvider)
            }

            if isPerplexity && !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                store.savePerplexityKey(perplexityKeyText, onSuccess: { [self] in
                    perplexityHasKey = true
                })
                perplexityKeyText = ""
            }
            if isBrave && !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                store.saveBraveKey(braveKeyText, onSuccess: { [self] in
                    braveHasKey = true
                })
                braveKeyText = ""
            }
        }

        // Update initial provider to reflect persisted state
        initialProvider = draftProvider
    }
}
