import SwiftUI
import VellumAssistantShared

/// Card for the web search service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode, inference mode, and auth state:
/// - **Managed + Managed inference + logged in**: Message that web search is included.
/// - **Managed + Managed inference + not logged in**: Login prompt.
/// - **Managed + Your Own inference**: Message that managed web search is not yet available.
/// - **Your Own**: Provider picker + API key. Provider Native is available whenever the
///   inference provider supports native web search (e.g. Anthropic, OpenAI), regardless of
///   inference mode. Perplexity and Brave are always available as key-based alternatives.
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
    /// Tail of the serial chain of in-flight `services.web-search.provider` PATCHes.
    /// Both the auto-fallback writes in `onChange` and the explicit `save()` write
    /// go through `enqueueProviderWrite` — chaining on this task guarantees the
    /// last-enqueued value is the one the daemon ends up persisting, so a stale
    /// auto-fallback PATCH cannot land after a user's explicit save.
    @State private var pendingProviderWrite: Task<Void, Never>?

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

    /// The available providers depend on the current inference selection's capabilities.
    /// Provider Native is available whenever the inference provider supports native web search
    /// (e.g. Anthropic, OpenAI, or OpenRouter routing to an `anthropic/*` model),
    /// regardless of whether inference is managed or your-own.
    private var availableProviders: [String] {
        store.isNativeWebSearchCapable(store.selectedInferenceProvider, model: store.selectedModel)
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
                // Only auto-correct when the managed provider lacks native web search support.
                if !store.isNativeWebSearchCapable(store.selectedInferenceProvider, model: store.selectedModel) {
                    draftProvider = "perplexity"
                }
            }
        }
        .onChange(of: store.selectedInferenceProvider) { _, newProvider in
            // Auto-correct when the inference provider changes to one that
            // does not support native web search while provider-native is selected.
            // Persist the fix so the daemon's services.web-search.provider does
            // not remain pinned to "inference-provider-native" while the new
            // provider can't support it — otherwise getWebSearchProvider falls
            // back to Perplexity and breaks search for users without a key.
            if draftProvider == "inference-provider-native" && !store.isNativeWebSearchCapable(newProvider, model: store.selectedModel) {
                draftProvider = "perplexity"
                if store.webSearchProvider == "inference-provider-native" {
                    enqueueProviderWrite { _ = await store.setWebSearchProvider("perplexity").value }
                    initialProvider = "perplexity"
                }
            }
        }
        .onChange(of: store.selectedModel) { _, newModel in
            // Auto-correct when the model changes to one that breaks native web search
            // for the current provider (e.g. OpenRouter switching off an `anthropic/*` model).
            // Persist the fix — see comment on selectedInferenceProvider above.
            if draftProvider == "inference-provider-native" && !store.isNativeWebSearchCapable(store.selectedInferenceProvider, model: newModel) {
                draftProvider = "perplexity"
                if store.webSearchProvider == "inference-provider-native" {
                    enqueueProviderWrite { _ = await store.setWebSearchProvider("perplexity").value }
                    initialProvider = "perplexity"
                }
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
                        AppDelegate.shared?.handlePlatformLoginSucceeded()
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
        APIKeyTextField(
            label: "API Key",
            hasKey: isPerplexity ? perplexityHasKey : braveHasKey,
            text: isPerplexity ? $perplexityKeyText : $braveKeyText,
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
            // Funnel through the serial provider queue so any in-flight
            // auto-fallback PATCH cannot land after this explicit save.
            let capturedProvider = draftProvider
            enqueueProviderWrite {
                if let pendingMode { _ = await pendingMode.value }
                _ = await store.setWebSearchProvider(capturedProvider).value
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

    /// Serializes provider PATCHes by chaining each new write onto the tail of
    /// the previous in-flight task. The last enqueued value wins deterministically.
    private func enqueueProviderWrite(_ work: @MainActor @escaping () async -> Void) {
        let previous = pendingProviderWrite
        pendingProviderWrite = Task { @MainActor in
            _ = await previous?.value
            await work()
        }
    }
}
