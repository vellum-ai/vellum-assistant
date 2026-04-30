import SwiftUI
import VellumAssistantShared

/// Card for the inference service with Managed/Your Own mode toggle.
///
/// Shows different content based on mode and auth state:
/// - **Managed + logged in**: Provider picker (managed-capable only),
///   Active Profile picker, Manage Profiles button, Save button
/// - **Managed + not logged in**: Empty state prompting login
/// - **Your Own**: Provider picker (all), API key field, Active Profile picker,
///   Manage Profiles button, Save + Reset buttons
///
/// Active Model is no longer chosen on this card — it lives inside an
/// inference profile. The profile dropdown writes through
/// `store.setActiveProfile(_:)` on selection change; Save persists Provider
/// and API key only.
@MainActor
struct InferenceServiceCard: View {
    @ObservedObject var store: SettingsStore
    @Environment(AssistantFeatureFlagStore.self) private var assistantFeatureFlagStore: AssistantFeatureFlagStore?
    var authManager: AuthManager
    @Binding var apiKeyText: String
    var showToast: (String, ToastInfo.Style) -> Void

    /// Local draft of the mode selection — only persisted on Save.
    @State private var draftMode: String = "your-own"
    /// Whether to show the web search impact confirmation alert.
    @State private var showWebSearchAlert = false
    /// Local draft of the provider selection — only persisted on Save.
    @State private var draftProvider: String = "anthropic"
    /// Snapshot of the provider at card appear — used to detect provider changes.
    @State private var initialProvider: String = ""
    /// Guards against provider-change side-effects during initial load.
    @State private var didInitialSync = false
    /// Set `true` right before an external store sync updates `draftProvider`,
    /// so `onChange(of: draftProvider)` can distinguish daemon-driven updates
    /// from user-initiated picks and skip the API-key reset.
    @State private var isSyncingProviderFromStore = false
    /// Whether the current provider has a stored API key (fetched per-component).
    @State private var providerHasKey = false
    /// Whether the read-only per-call-site overrides sheet is presented.
    @State private var showOverridesSheet = false
    /// Whether the inference profiles management sheet is presented.
    @State private var showProfilesSheet = false
    /// Whether to show the per-call-site override confirmation dialog. Fires
    /// when the user is about to switch the global provider AND has at least
    /// one override pinned to the OLD provider — we ask whether to keep those
    /// pins or reset them to follow the new default.
    @State private var showOverrideConfirmation = false
    /// Snapshot of the overrides pinned to the OLD provider at the moment the
    /// confirmation dialog is shown. Used both to render the dialog message
    /// (count + provider name) and to drive the "Reset" action.
    @State private var pendingOverrideClears: [CallSiteOverride] = []
    /// The provider name displayed in the confirmation dialog message.
    /// Captured at confirmation time so the message stays accurate even if
    /// `initialProvider` is mutated during the deferred save.
    @State private var pendingOverrideOldProviderName: String = ""
    /// The most recent in-flight `setActiveProfile` task, retained so a
    /// subsequent dropdown pick can cancel it and avoid an out-of-order
    /// PATCH landing the older selection last.
    @State private var activeProfileTask: Task<Void, Never>?
    /// Whether the API keys management sheet is presented.
    @State private var showAPIKeysSheet = false
    /// Per-provider key-exists status. Loaded async on appear and refreshed
    /// after the API keys sheet is dismissed.
    @State private var providerKeyStatuses: [String: Bool] = [:]
    /// Monotonically increasing counter bumped every time the API keys
    /// sheet is dismissed. Drives `.task(id:)` to re-fetch key statuses
    /// without a manual onChange handler.
    @State private var apiKeysRefreshToken: Int = 0

    // MARK: - Provider Helpers

    private var effectiveProvider: String {
        draftProvider
    }

    private var providerDisplayName: String {
        store.dynamicProviderDisplayName(effectiveProvider)
    }

    // MARK: - Computed State

    private var profilesEnabled: Bool {
        assistantFeatureFlagStore?.isEnabled("inference-profiles") == true
    }

    private var isLoggedIn: Bool {
        authManager.isAuthenticated
    }

    /// True when at least one key-required provider has a configured API key.
    private var hasAnyProviderKey: Bool {
        providerKeyStatuses.values.contains(true)
    }

    /// True when changing inference mode/provider would invalidate the current
    /// web search config. Model is no longer staged on this card — the
    /// daemon-resolved `store.selectedModel` (set by the active profile) is
    /// used to evaluate native web-search capability for the new provider.
    private var wouldInvalidateWebSearch: Bool {
        let modeChanging = draftMode != store.inferenceMode
        let providerChanging = draftProvider != store.selectedInferenceProvider
        guard modeChanging || providerChanging else { return false }

        // Switching to Your Own inference while web search is Managed
        // (managed web search requires managed inference).
        if modeChanging && draftMode == "your-own" && store.webSearchMode == "managed" {
            return true
        }
        // Switching to Managed inference while web search uses Provider Native —
        // only invalidate when the resulting provider cannot support native web search.
        // Skip when web search is in managed mode (webSearchProvider is stale).
        if draftMode == "managed" && store.webSearchMode == "your-own" && store.webSearchProvider == "inference-provider-native" {
            if !store.isNativeWebSearchCapable(draftProvider, model: store.selectedModel) {
                return true
            }
        }
        // Switching providers while web search uses Provider Native —
        // invalidate when the new provider cannot support native web search
        // for the currently-resolved model.
        // Skip when web search is in managed mode (webSearchProvider is stale).
        if providerChanging && store.webSearchMode == "your-own" && store.webSearchProvider == "inference-provider-native" {
            if !store.isNativeWebSearchCapable(draftProvider, model: store.selectedModel) {
                return true
            }
        }
        return false
    }

    /// True when the user has made changes worth saving.
    private var hasChanges: Bool {
        // In managed mode when not logged in, there is nothing actionable to save.
        if draftMode == "managed" && !isLoggedIn {
            return false
        }
        let modeChanged = draftMode != store.inferenceMode
        // When profiles are enabled, API keys are managed in the sheet —
        // the card's Save button only covers mode changes.
        let hasNewKey = !profilesEnabled && draftMode == "your-own"
            && !apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let providerChanged = draftProvider != initialProvider
        return modeChanged || hasNewKey || providerChanged
    }

    var body: some View {
        ServiceModeCard(
            title: "Inference",
            subtitle: "Configure which model to power your assistant",
            draftMode: $draftMode,
            managedContent: {
                if isLoggedIn {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        if profilesEnabled {
                            activeProfilePicker
                            secondaryActionsRow
                            if hasChanges {
                                ServiceCardActions(
                                    hasChanges: true,
                                    isSaving: false,
                                    onSave: { save() }
                                )
                            }
                        } else {
                            managedProviderPicker
                            ServiceCardActions(
                                hasChanges: hasChanges,
                                isSaving: store.apiKeySaving,
                                onSave: { save() }
                            )
                        }
                    }
                } else {
                    managedLoginPrompt
                }
            },
            yourOwnContent: {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    if profilesEnabled && hasAnyProviderKey {
                        apiKeysSection
                        activeProfilePicker
                        secondaryActionsRow
                        if hasChanges {
                            ServiceCardActions(
                                hasChanges: true,
                                isSaving: false,
                                onSave: { save() }
                            )
                        }
                    } else if profilesEnabled {
                        apiKeysEmptyState
                    } else {
                        providerPicker
                        apiKeyField
                        ServiceCardActions(
                            hasChanges: hasChanges,
                            isSaving: store.apiKeySaving,
                            onSave: { save() },
                            savingLabel: "Validating...",
                            onReset: {
                                store.clearAPIKeyForProvider(effectiveProvider)
                                providerHasKey = false
                                apiKeyText = ""
                            },
                            showReset: providerHasKey
                        )
                    }
                }
            },
            footer: {
                EmptyView()
            }
        )
        .sheet(isPresented: $showOverridesSheet) {
            CallSiteOverridesSheet(store: store, isPresented: $showOverridesSheet)
        }
        .sheet(isPresented: $showProfilesSheet) {
            InferenceProfilesSheet(store: store, isPresented: $showProfilesSheet)
        }
        .sheet(isPresented: $showAPIKeysSheet) {
            APIKeysSheet(store: store, isPresented: $showAPIKeysSheet, showToast: showToast)
        }
        .onChange(of: showAPIKeysSheet) { _, isShowing in
            // Refresh key statuses when the sheet is dismissed so the card
            // summary reflects any keys added or removed in the sheet.
            if !isShowing {
                apiKeysRefreshToken += 1
            }
        }
        .task(id: apiKeysRefreshToken) {
            await loadProviderKeyStatuses()
        }
        .onAppear {
            draftMode = store.inferenceMode
            // Mirror the store-sync pattern used in
            // onChange(of: store.selectedInferenceProvider): flag the pending
            // mutation BEFORE assigning draftProvider so the deferred
            // onChange(of: draftProvider) callback (which SwiftUI runs after
            // this closure returns) skips the API-key reset. Without this,
            // any user whose saved provider differs from the @State default
            // "anthropic" sees apiKeyText cleared right after onAppear settles.
            let alreadyEqualProvider = draftProvider == store.selectedInferenceProvider
            isSyncingProviderFromStore = true
            draftProvider = store.selectedInferenceProvider
            if alreadyEqualProvider {
                isSyncingProviderFromStore = false
            }
            initialProvider = store.selectedInferenceProvider
            didInitialSync = true

            // If the user is not authenticated and the persisted mode is
            // "managed", reset the draft so the UI shows "your-own".
            // When auth is still loading (startup), only reset the draft —
            // the persisted mode is preserved so it can be restored when
            // auth completes. When auth is confirmed absent, also persist
            // the reset so the daemon doesn't attempt managed-proxy routing.
            if !isLoggedIn && draftMode == "managed" {
                draftMode = "your-own"
                if !authManager.isLoading {
                    store.setInferenceMode("your-own")
                }
            }

            // Symmetric case: if the user is authenticated and the mode is
            // still the default "your-own", switch to "managed" so signed-in
            // users get managed inference out of the box — but only when the
            // provider is managed-capable, requires an API key, and the user
            // hasn't configured one. Providers like Ollama that don't use keys
            // (apiKeyPlaceholder is nil) or non-managed providers (fireworks,
            // openrouter) are left alone since the user intentionally set up
            // that provider.
            let providerRequiresKey = store.dynamicProviderApiKeyPlaceholder(draftProvider) != nil
            let hasLocalKey = APIKeyManager.getKey(for: draftProvider) != nil
            let providerIsManagedCapable = store.isManagedCapable(draftProvider)
            if isLoggedIn && draftMode == "your-own" && providerIsManagedCapable && providerRequiresKey && !hasLocalKey {
                draftMode = "managed"
                store.setInferenceMode("managed")
            }
        }
        .onChange(of: store.inferenceMode) { _, newValue in
            // Sync draft when external changes arrive (e.g. daemon reload),
            // but guard against adopting managed mode while unauthenticated.
            if newValue == "managed" && !isLoggedIn {
                draftMode = "your-own"
            } else {
                draftMode = newValue
            }
        }
        .onChange(of: authManager.isAuthenticated) { _, isAuthenticated in
            if !isAuthenticated && draftMode == "managed" {
                // When the user logs out while this card is mounted, reset
                // both the draft and the persisted mode so the daemon doesn't
                // attempt managed-proxy routing while unauthenticated.
                draftMode = "your-own"
                store.setInferenceMode("your-own")
            } else if isAuthenticated && store.inferenceMode == "managed" {
                // When auth becomes available (e.g. startup transition from
                // loading to authenticated), restore the persisted managed
                // mode that onAppear may have temporarily overridden.
                draftMode = "managed"
            } else if isAuthenticated && store.inferenceMode == "your-own" {
                // When a user signs in and has no BYO key for a managed-capable,
                // key-based provider, default to managed. Keyless providers
                // (e.g. Ollama) and non-managed providers are left in your-own mode.
                let requiresKey = store.dynamicProviderApiKeyPlaceholder(draftProvider) != nil
                let hasLocalKey = APIKeyManager.getKey(for: draftProvider) != nil
                let isManagedCapable = store.isManagedCapable(draftProvider)
                if isManagedCapable && requiresKey && !hasLocalKey {
                    draftMode = "managed"
                    store.setInferenceMode("managed")
                }
            }
        }
        .onChange(of: authManager.isLoading) { _, isLoading in
            // When auth finishes loading without authenticating, persist
            // the mode reset that onAppear deferred during the loading
            // state. Without this, the persisted mode stays "managed"
            // while the UI shows "your-own" — pressing Save for unrelated
            // edits would not trigger a mode change since draftMode already
            // equals the visual state.
            if !isLoading && !isLoggedIn && store.inferenceMode == "managed" {
                store.setInferenceMode("your-own")
            }
        }
        .onChange(of: store.selectedInferenceProvider) { _, newValue in
            // Sync draft & baseline when the daemon reports a provider
            // update. Flag the update so onChange(of: draftProvider) skips
            // the API-key reset that is only appropriate for user picks.
            let alreadyEqual = draftProvider == newValue
            isSyncingProviderFromStore = true
            draftProvider = newValue
            // If draftProvider already held this value, SwiftUI's
            // onChange(of: draftProvider) won't fire (it only fires on
            // actual value transitions), so clear the flag immediately
            // to prevent the next user-initiated change from being
            // misclassified as a store sync.
            if alreadyEqual {
                isSyncingProviderFromStore = false
            }
            initialProvider = newValue
        }
        .onChange(of: draftProvider) { _, _ in
            // Clear any unsaved API key text on user-initiated provider
            // changes — it belongs to the previous provider's context.
            // External store syncs set isSyncingProviderFromStore before
            // mutating draftProvider; clear the flag and skip.
            if isSyncingProviderFromStore {
                isSyncingProviderFromStore = false
                return
            }
            guard didInitialSync else { return }
            apiKeyText = ""
        }
        .onChange(of: draftMode) { _, newMode in
            if newMode == "managed" {
                // When switching to managed mode, fall back to a managed-capable
                // provider if the current one does not support managed routing.
                if !store.isManagedCapable(draftProvider) {
                    draftProvider = "anthropic"
                }
            }
        }
        .task(id: effectiveProvider) {
            providerHasKey = await APIKeyManager.hasKey(for: effectiveProvider)
        }
        .alert("Heads up", isPresented: $showWebSearchAlert) {
            Button("Go Back", role: .cancel) {}
            Button("Continue") { performSave() }
        } message: {
            Text(
                "Changing your inference settings will also update your Web Search settings."
                    + " You'll need to review and save them below."
            )
        }
        .confirmationDialog(
            "Keep per-task overrides?",
            isPresented: $showOverrideConfirmation,
            titleVisibility: .visible
        ) {
            Button("Keep overrides") {
                performSaveCore(clearingOverrides: [])
            }
            Button("Reset to follow default") {
                performSaveCore(clearingOverrides: pendingOverrideClears)
            }
            Button("Cancel", role: .cancel) {
                pendingOverrideClears = []
                pendingOverrideOldProviderName = ""
            }
        } message: {
            let msg = "\(pendingOverrideClears.count) task(s) are pinned to \(pendingOverrideOldProviderName). Keep them as-is, or update them to follow the new default?"
            Text(msg)
        }
    }

    // MARK: - Secondary Actions Row

    /// Consolidated row of ghost-styled buttons for managing API keys,
    /// profiles, and per-task overrides. Shown in both Managed and Your Own
    /// modes when inference-profiles is enabled.
    private var secondaryActionsRow: some View {
        let overridesLabel = store.overridesCount > 0
            ? "\(store.overridesCount) Override\(store.overridesCount == 1 ? "" : "s")"
            : "Overrides"

        return HStack(spacing: VSpacing.sm) {
            if draftMode == "your-own" {
                VButton(label: "API Keys", style: .ghost, size: .compact) {
                    showAPIKeysSheet = true
                }
            }
            VButton(label: "Profiles", style: .ghost, size: .compact) {
                showProfilesSheet = true
            }
            VButton(label: overridesLabel, style: .ghost, size: .compact) {
                showOverridesSheet = true
            }
        }
    }

    // MARK: - Managed Login Prompt

    private var managedLoginPrompt: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Log in to Vellum to use managed inference.")
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
                options: store.dynamicProviderIds.map { provider in
                    (label: store.dynamicProviderDisplayName(provider), value: provider)
                }
            )
        }
    }

    /// Provider picker filtered to managed-capable providers, shown in managed mode.
    private var managedProviderPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $draftProvider,
                options: store.managedCapableProviders.map { entry in
                    (label: entry.displayName, value: entry.id)
                }
            )
        }
    }

    // MARK: - API Key Field

    private var apiKeyField: some View {
        APIKeyTextField(
            label: "\(providerDisplayName) API Key",
            hasKey: providerHasKey,
            text: $apiKeyText,
            emptyPlaceholder: {
                if let p = store.dynamicProviderApiKeyPlaceholder(effectiveProvider), !p.isEmpty { return p }
                return "Enter your API key"
            }(),
            errorMessage: store.apiKeySaveError
        )
        .disabled(store.apiKeySaving)
    }

    // MARK: - Multi-Provider API Keys Section

    /// Compact summary of configured provider API keys, shown in "Your Own"
    /// mode when the inference-profiles feature flag is enabled and at least
    /// one key exists. Shows provider chips only — the "API Keys" action
    /// button lives in the consolidated `secondaryActionsRow`.
    private var apiKeysSection: some View {
        let configuredProviders = store.providerCatalog
            .filter { $0.apiKeyPlaceholder != nil && providerKeyStatuses[$0.id] == true }

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("API Keys")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            HStack(spacing: VSpacing.sm) {
                ForEach(configuredProviders, id: \.id) { provider in
                    VTag(provider.displayName, color: VColor.systemPositiveStrong, icon: .check)
                }
            }
        }
    }

    /// Friendly empty state shown when profiles are enabled but no provider
    /// API keys have been configured yet. Replaces the profile picker and
    /// overrides controls since they can't do anything without credentials.
    private var apiKeysEmptyState: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.keyRound, size: 28)
                .foregroundStyle(VColor.contentTertiary)

            VStack(spacing: VSpacing.xs) {
                Text("Bring your own keys")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("Add API keys for the LLM providers you want to use.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VButton(label: "Add API Keys", style: .primary) {
                showAPIKeysSheet = true
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.lg)
    }

    /// Fetches the key-exists status for every key-required provider.
    private func loadProviderKeyStatuses() async {
        for provider in store.providerCatalog where provider.apiKeyPlaceholder != nil {
            providerKeyStatuses[provider.id] = await APIKeyManager.hasKey(for: provider.id)
        }
    }

    // MARK: - Active Profile Picker

    /// Binding that writes through to `store.setActiveProfile(_:)` on user
    /// picks. Daemon-pushed updates flow back through `store.activeProfile`
    /// directly via the published-value re-render; SwiftUI never invokes
    /// `set` for those, so no sync-suppression flag is needed. The
    /// equality guard short-circuits the rare echo where SwiftUI reflects
    /// the latest `get` back through the dropdown's `set`.
    ///
    /// `setActiveProfile` updates `store.activeProfile` synchronously
    /// (optimistic update) so the dropdown reflects the new selection
    /// immediately; the await only carries the network PATCH. Each pick
    /// cancels any prior in-flight task to prevent a slower earlier
    /// PATCH from landing the older selection last.
    private var activeProfileBinding: Binding<String> {
        Binding(
            get: { store.activeProfile },
            set: { newValue in
                guard newValue != store.activeProfile else { return }
                activeProfileTask?.cancel()
                activeProfileTask = Task { _ = await store.setActiveProfile(newValue) }
            }
        )
    }

    private var activeProfilePicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Default Profile")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a profile\u{2026}",
                selection: activeProfileBinding,
                options: store.profiles.map { (label: $0.displayName, value: $0.name) }
            )
        }
    }

    // MARK: - Save

    private func save() {
        if wouldInvalidateWebSearch {
            showWebSearchAlert = true
            return
        }
        performSave()
    }

    private func performSave() {
        let persistProvider = draftProvider

        // If the resolved provider ID is changing AND the user has any
        // per-call-site overrides pinned to the OLD provider, ask whether
        // to keep those pins or reset them. Only check when the actual
        // provider ID differs — a pure mode toggle (e.g. your-own →
        // managed) where both old and new resolve to the same provider
        // (e.g. both "anthropic") should not prompt because there is no
        // provider switch for overrides to reconcile against.
        let providerIdChanged = persistProvider != initialProvider
        if providerIdChanged {
            let overridesPinnedToOldProvider = store.callSiteOverrides.filter {
                $0.provider == initialProvider
            }
            if !overridesPinnedToOldProvider.isEmpty {
                let profilesEnabled = assistantFeatureFlagStore?.isEnabled("inference-profiles") == true
                if profilesEnabled {
                    // Show the confirmation dialog so the user can choose
                    // to keep or reset overrides pinned to the old provider.
                    pendingOverrideClears = overridesPinnedToOldProvider
                    pendingOverrideOldProviderName = store.dynamicProviderDisplayName(initialProvider)
                    showOverrideConfirmation = true
                    return
                } else {
                    // When inference-profiles is off the overrides UI is
                    // hidden, so silently clear stale overrides to prevent
                    // invisible provider/model mismatches for affected tasks.
                    performSaveCore(clearingOverrides: overridesPinnedToOldProvider)
                    return
                }
            }
        }

        performSaveCore(clearingOverrides: [])
    }

    /// Persists the staged inference settings (mode, provider, API key).
    /// Active Model is no longer written from here — the active profile owns
    /// model selection.
    ///
    /// `clearingOverrides` is the set of overrides to clear before the save
    /// (e.g. when the user picks "Reset to follow default" from the override
    /// confirmation dialog). Pass an empty array to leave all overrides intact.
    private func performSaveCore(clearingOverrides overridesToClear: [CallSiteOverride]) {
        store.apiKeySaveError = nil

        // Clear any overrides the user opted to reset before persisting the
        // new defaults. Done first so the daemon sees the cleared overrides
        // when it processes the subsequent provider patch.
        for override in overridesToClear {
            _ = store.clearCallSiteOverride(override.id)
        }
        // Reset stash regardless of which path we came from so a future
        // confirmation dialog renders fresh state.
        pendingOverrideClears = []
        pendingOverrideOldProviderName = ""

        // Detect mode change before persisting so downstream logic can
        // force-persist provider even when IDs happen to match.
        let modeChanged = draftMode != store.inferenceMode

        // Persist mode if changed. The mode write goes to
        // `services.inference.mode`, separate from `llm.default` — but we
        // capture the pending Task so the provider PATCH below can wait
        // for it. Otherwise the daemon's ConfigWatcher could see the
        // provider write reflect new mode-derived defaults before the mode
        // itself has been persisted.
        let pendingMode = modeChanged ? store.setInferenceMode(draftMode) : nil

        // Resolve the provider that will land in `llm.default.provider`.
        // Also flag re-persist when the mode changed — switching between
        // managed and your-own implies a provider change even if the
        // resolved provider ID happens to match initialProvider (ensures
        // config stays consistent).
        let persistProvider = draftProvider
        let providerChanged = persistProvider != initialProvider || modeChanged
        if providerChanged {
            initialProvider = draftProvider
        }

        // Persist API key if entered and in your-own mode (legacy single-key
        // path). When profiles are enabled, keys are managed in the API Keys
        // sheet — not inline on this card.
        if !profilesEnabled {
            let trimmedKey = apiKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
            if draftMode == "your-own" && !trimmedKey.isEmpty {
                let keyTextBinding = $apiKeyText
                let displayName = providerDisplayName
                store.saveInferenceAPIKey(trimmedKey, provider: effectiveProvider, onSuccess: { [self] in
                    providerHasKey = true
                    keyTextBinding.wrappedValue = ""
                    showToast("\(displayName) API key saved", .success)
                })
            }
        }

        // Persist provider in a single PATCH when it changed (or when the
        // mode toggled, which forces a re-persist even when the resolved
        // ID matches). Active Profile is its own setter that fires on
        // selection change, so we do not write `llm.default.model` here.
        //
        // Awaiting `pendingMode` first ensures `services.inference.mode`
        // has landed before the daemon picks up the new provider.
        if providerChanged {
            let capturedProvider = persistProvider
            Task {
                if let pendingMode { _ = await pendingMode.value }
                _ = await store.setLLMDefaultProvider(capturedProvider).value
            }
        }
    }
}
