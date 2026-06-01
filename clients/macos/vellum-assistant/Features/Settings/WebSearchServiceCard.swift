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
///   inference mode. Perplexity, Brave, and Tavily are always available as key-based alternatives.
///   In Managed mode, non-native inference providers can still use platform-backed app-executed
///   web search, so the card does not rewrite Provider Native to a BYOK provider.
@MainActor
struct WebSearchServiceCard: View {
    @ObservedObject var store: SettingsStore
    var authManager: AuthManager
    @Binding var perplexityKeyText: String
    @Binding var braveKeyText: String
    @Binding var tavilyKeyText: String
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
    /// Whether the Tavily provider has a stored API key (fetched per-component).
    @State private var tavilyHasKey = false
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

    private var isTavily: Bool {
        draftProvider == "tavily"
    }

    private var needsAPIKey: Bool {
        isPerplexity || isBrave || isTavily
    }

    private var selectedProviderHasKey: Bool {
        if isPerplexity { return perplexityHasKey }
        if isBrave { return braveHasKey }
        if isTavily { return tavilyHasKey }
        assertionFailure("selectedProviderHasKey called for non-key provider: \(draftProvider)")
        return false
    }

    private var selectedProviderKeyText: Binding<String> {
        if isPerplexity { return $perplexityKeyText }
        if isBrave { return $braveKeyText }
        if isTavily { return $tavilyKeyText }
        assertionFailure("selectedProviderKeyText called for non-key provider: \(draftProvider)")
        return $tavilyKeyText
    }

    private var selectedProviderKeyError: String? {
        if isPerplexity { return store.perplexityKeySaveError }
        if isBrave { return store.braveKeySaveError }
        if isTavily { return store.tavilyKeySaveError }
        assertionFailure("selectedProviderKeyError called for non-key provider: \(draftProvider)")
        return nil
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
            ? ["inference-provider-native", "perplexity", "brave", "tavily"]
            : ["perplexity", "brave", "tavily"]
    }

    private var shouldAutoFallbackProviderNative: Bool {
        draftMode == "your-own"
            && draftProvider == "inference-provider-native"
            && !store.isNativeWebSearchCapable(store.selectedInferenceProvider, model: store.selectedModel)
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        if draftMode == "managed" {
            // Managed but not logged in: nothing actionable.
            if !isLoggedIn {
                return false
            }
            // Managed mode prefers provider-native search. If a previous
            // Your Own selection left a BYOK provider stored, Save restores
            // the native preference so OpenAI/Anthropic use hosted search and
            // non-native providers fall back to managed Brave.
            return draftMode != store.webSearchMode
                || store.webSearchProvider != "inference-provider-native"
        }

        // Your Own mode: detect mode, provider, and API key changes.
        let modeChanged = draftMode != store.webSearchMode
        let providerChanged = draftProvider != initialProvider
        let hasNewKey: Bool = {
            if isPerplexity {
                return !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            } else if isBrave {
                return !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            } else if isTavily {
                return !tavilyKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
                if isLoggedIn {
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
                                clearSelectedProviderKey()
                            },
                            showReset: selectedProviderHasKey
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
            tavilyHasKey = await APIKeyManager.hasKey(for: "tavily")
        }
        .onChange(of: store.webSearchMode) { _, newValue in
            draftMode = newValue
        }
        .onChange(of: draftMode) { _, newValue in
            if newValue == "your-own" && shouldAutoFallbackProviderNative {
                draftProvider = "perplexity"
            }
        }
        .onChange(of: store.webSearchProvider) { _, newValue in
            draftProvider = newValue
            initialProvider = newValue
        }
        .onChange(of: store.selectedInferenceProvider) { _, newProvider in
            // In Your Own mode, auto-correct when the inference provider changes
            // to one that does not support native web search while provider-native
            // is selected. In Managed mode, keep the provider selection stable:
            // non-native providers use the platform-backed app-executed fallback.
            if draftMode == "your-own" && draftProvider == "inference-provider-native" && !store.isNativeWebSearchCapable(newProvider, model: store.selectedModel) {
                draftProvider = "perplexity"
                if store.webSearchProvider == "inference-provider-native" {
                    enqueueProviderWrite { _ = await store.setWebSearchProvider("perplexity").value }
                    initialProvider = "perplexity"
                }
            }
        }
        .onChange(of: store.selectedModel) { _, newModel in
            // Auto-correct in Your Own mode when the model changes to one that
            // breaks native web search for the current provider (e.g. OpenRouter
            // switching off an `anthropic/*` model). Managed mode keeps the
            // selection and uses the app-executed fallback instead.
            if draftMode == "your-own" && draftProvider == "inference-provider-native" && !store.isNativeWebSearchCapable(store.selectedInferenceProvider, model: newModel) {
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
            hasKey: selectedProviderHasKey,
            text: selectedProviderKeyText,
            errorMessage: selectedProviderKeyError,
            maxWidth: 400
        )
    }

    // MARK: - Save

    private func save() {
        let modeChanged = draftMode != store.webSearchMode
        let shouldRestoreManagedProvider =
            draftMode == "managed" && store.webSearchProvider != "inference-provider-native"
        let pendingMode =
            (modeChanged || shouldRestoreManagedProvider)
                ? store.setWebSearchMode(draftMode)
                : nil

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

            saveSelectedProviderKeyIfNeeded()
        } else {
            draftProvider = "inference-provider-native"
        }

        // Update initial provider to reflect persisted state
        initialProvider = draftProvider
    }

    private func saveSelectedProviderKeyIfNeeded() {
        if isPerplexity && !perplexityKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.savePerplexityKey(perplexityKeyText, onSuccess: { [self] in
                perplexityHasKey = true
            })
            perplexityKeyText = ""
        } else if isBrave && !braveKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.saveBraveKey(braveKeyText, onSuccess: { [self] in
                braveHasKey = true
            })
            braveKeyText = ""
        } else if isTavily && !tavilyKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.saveTavilyKey(tavilyKeyText, onSuccess: { [self] in
                tavilyHasKey = true
            })
            tavilyKeyText = ""
        }
    }

    private func clearSelectedProviderKey() {
        if isPerplexity {
            store.clearPerplexityKey()
            perplexityHasKey = false
            perplexityKeyText = ""
        } else if isBrave {
            store.clearBraveKey()
            braveHasKey = false
            braveKeyText = ""
        } else if isTavily {
            store.clearTavilyKey()
            tavilyHasKey = false
            tavilyKeyText = ""
        }
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
