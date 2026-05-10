import SwiftUI
import VellumAssistantShared

/// Card for the inference service provider and profile configuration.
///
/// Shows the global provider picker, active profile selector, and
/// management buttons for provider connections, profiles, and per-call-site
/// overrides. Saving persists the provider selection only — model selection
/// lives inside inference profiles.
@MainActor
struct InferenceServiceCard: View {
    @ObservedObject var store: SettingsStore
    var showToast: (String, ToastInfo.Style) -> Void

    /// Local draft of the provider selection — only persisted on Save.
    @State private var draftProvider: String = "anthropic"
    /// Snapshot of the provider at card appear — used to detect provider changes.
    @State private var initialProvider: String = ""
    /// Whether the read-only per-call-site overrides sheet is presented.
    @State private var showOverridesSheet = false
    /// Whether the inference profiles management sheet is presented.
    @State private var showProfilesSheet = false
    /// Whether the provider connections management sheet is presented.
    @State private var showProvidersSheet = false
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
    @State private var pendingOverrideOldProviderName: String = ""
    /// The most recent in-flight `setActiveProfile` task, retained so a
    /// subsequent dropdown pick can cancel it and avoid an out-of-order
    /// PATCH landing the older selection last.
    @State private var activeProfileTask: Task<Void, Never>?

    // MARK: - Computed State

    private var hasChanges: Bool {
        draftProvider != initialProvider
    }

    var body: some View {
        SettingsCard(title: "Language Model", subtitle: "Configure the LLMs that power your assistant") {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                providerPicker
                activeProfilePicker
                secondaryActionsRow
                if hasChanges {
                    ServiceCardActions(
                        hasChanges: true,
                        isSaving: false,
                        onSave: { save() }
                    )
                }
            }
        }
        .sheet(isPresented: $showOverridesSheet) {
            CallSiteOverridesSheet(store: store, isPresented: $showOverridesSheet)
        }
        .sheet(isPresented: $showProfilesSheet) {
            InferenceProfilesSheet(store: store, isPresented: $showProfilesSheet)
        }
        .sheet(isPresented: $showProvidersSheet) {
            ProvidersSheet(store: store, isPresented: $showProvidersSheet)
        }
        .onAppear {
            draftProvider = store.selectedInferenceProvider
            initialProvider = store.selectedInferenceProvider
        }
        .onChange(of: store.selectedInferenceProvider) { _, newValue in
            draftProvider = newValue
            initialProvider = newValue
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

    // MARK: - Provider Picker

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $draftProvider,
                options: store.providerCatalog.map { (label: $0.displayName, value: $0.id) }
            )
        }
    }

    // MARK: - Secondary Actions Row

    private var secondaryActionsRow: some View {
        let overridesLabel = store.overridesCount > 0
            ? "\(store.overridesCount) Override\(store.overridesCount == 1 ? "" : "s")"
            : "Overrides"

        return HStack(spacing: VSpacing.sm) {
            VButton(label: "Providers", style: .ghost, size: .compact) {
                showProvidersSheet = true
            }
            VButton(label: "Profiles", style: .ghost, size: .compact) {
                showProfilesSheet = true
            }
            VButton(label: overridesLabel, style: .ghost, size: .compact) {
                showOverridesSheet = true
            }
        }
    }

    // MARK: - Active Profile Picker

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
        performSave()
    }

    private func performSave() {
        let persistProvider = draftProvider
        let providerIdChanged = persistProvider != initialProvider
        if providerIdChanged {
            let overridesPinnedToOldProvider = store.callSiteOverrides.filter {
                $0.provider == initialProvider
            }
            if !overridesPinnedToOldProvider.isEmpty {
                pendingOverrideClears = overridesPinnedToOldProvider
                pendingOverrideOldProviderName = store.dynamicProviderDisplayName(initialProvider)
                showOverrideConfirmation = true
                return
            }
        }
        performSaveCore(clearingOverrides: [])
    }

    private func performSaveCore(clearingOverrides overridesToClear: [CallSiteOverride]) {
        store.apiKeySaveError = nil

        for override in overridesToClear {
            _ = store.clearCallSiteOverride(override.id)
        }
        pendingOverrideClears = []
        pendingOverrideOldProviderName = ""

        let persistProvider = draftProvider
        let providerChanged = persistProvider != initialProvider
        if providerChanged {
            initialProvider = draftProvider
            let capturedProvider = persistProvider
            Task {
                _ = await store.setLLMDefaultProvider(capturedProvider).value
            }
        }
    }
}
