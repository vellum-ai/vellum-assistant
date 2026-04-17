import SwiftUI
import VellumAssistantShared

/// Editable sheet listing every call site in the catalog, grouped by
/// `CallSiteDomain`. Each row exposes an "Override default" toggle plus
/// provider/model pickers. The sheet header provides batch actions —
/// "Save All" (only visible when any rows have unsaved drafts) and
/// "Reset All" (destructive, behind a confirmation dialog).
@MainActor
struct CallSiteOverridesSheet: View {
    @ObservedObject var store: SettingsStore
    @Binding var isPresented: Bool

    /// Working copies keyed by call-site ID. Edits live here until the user
    /// hits Save (per-row) or Save All (header). Drafts are seeded from
    /// `store.callSiteOverrides` on appear and re-synced when the store
    /// changes externally.
    @State private var drafts: [String: CallSiteOverride] = [:]

    /// Snapshot of the last persisted value we synced into each draft. Used
    /// by `syncDraftsFromStore` to distinguish "user has unsaved edits"
    /// (draft != lastSynced) from "store changed externally and we need to
    /// pick up the new value" (draft == lastSynced but lastSynced != new
    /// persisted). Without this, we would compare the draft to the *new*
    /// persisted value and incorrectly flag externally-updated rows as
    /// touched, which would let Save All clobber newer daemon-side updates.
    @State private var lastSyncedFromStore: [String: CallSiteOverride] = [:]

    /// Shows the destructive confirmation for Reset All.
    @State private var showResetAllConfirmation = false

    /// Snapshot of provider IDs and per-provider model IDs at sheet open.
    /// Captured once so each row sees the same catalog without each row
    /// re-querying the store on every render.
    private var providerIds: [String] { store.dynamicProviderIds }

    private var availableModels: [String: [String]] {
        var byProvider: [String: [String]] = [:]
        for providerId in providerIds {
            byProvider[providerId] = store.dynamicProviderModels(providerId).map(\.id)
        }
        return byProvider
    }

    /// Catalog entries grouped by domain in catalog order.
    private var entriesByDomain: [(domain: CallSiteDomain, entries: [CallSiteOverride])] {
        var grouped: [CallSiteDomain: [CallSiteOverride]] = [:]
        for entry in CallSiteCatalog.all {
            grouped[entry.domain, default: []].append(entry)
        }
        return CallSiteDomain.allCases
            .sorted { $0.sortOrder < $1.sortOrder }
            .compactMap { domain in
                guard let entries = grouped[domain], !entries.isEmpty else { return nil }
                return (domain: domain, entries: entries)
            }
    }

    /// True when at least one draft differs from the persisted value.
    /// Drives the visibility of the "Save All" header button.
    private var hasUnsavedDrafts: Bool {
        for (id, draft) in drafts {
            guard let original = persistedById[id] else { continue }
            if draft.provider != original.provider
                || draft.model != original.model
                || draft.profile != original.profile {
                return true
            }
        }
        return false
    }

    /// True when at least one persisted entry has any override set. Drives
    /// the visibility of the "Reset All" header button.
    private var hasAnyPersistedOverride: Bool {
        store.callSiteOverrides.contains { $0.hasOverride }
    }

    private var persistedById: [String: CallSiteOverride] {
        Dictionary(uniqueKeysWithValues: store.callSiteOverrides.map { ($0.id, $0) })
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            SettingsDivider()

            overridesList

            SettingsDivider()
            footer
        }
        .frame(width: 560, height: 540)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear { syncDraftsFromStore() }
        .onChange(of: store.callSiteOverrides) { _, _ in
            syncDraftsFromStore()
        }
        .confirmationDialog(
            "Reset all per-task overrides?",
            isPresented: $showResetAllConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reset All", role: .destructive) {
                resetAll()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every call site will follow your default provider and model. This cannot be undone.")
        }
    }

    // MARK: - Header / Footer

    private var header: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Per-Task Model Overrides")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Text("Pick a specific provider or model for individual tasks. Anything left off uses your default.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack(spacing: VSpacing.sm) {
                if hasUnsavedDrafts {
                    VButton(label: "Save All", style: .primary) {
                        saveAll()
                    }
                }
                if hasAnyPersistedOverride {
                    VButton(label: "Reset All", style: .dangerOutline) {
                        showResetAllConfirmation = true
                    }
                }
                VButton(
                    label: "Close",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    tintColor: VColor.contentTertiary
                ) {
                    isPresented = false
                }
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

    // MARK: - Overrides List

    private var overridesList: some View {
        List {
            ForEach(entriesByDomain, id: \.domain.id) { group in
                Section {
                    ForEach(group.entries) { entry in
                        CallSiteOverrideRow(
                            draft: draftBinding(for: entry.id),
                            original: persistedById[entry.id] ?? entry,
                            providerIds: providerIds,
                            defaultProvider: store.selectedInferenceProvider,
                            providerDisplayName: { store.dynamicProviderDisplayName($0) },
                            availableModels: availableModels,
                            modelDisplayName: { provider, modelId in
                                let models = store.dynamicProviderModels(provider)
                                return models.first { $0.id == modelId }?.displayName ?? modelId
                            },
                            onSave: { save(id: entry.id) },
                            onClear: { clear(id: entry.id) }
                        )
                    }
                } header: {
                    Text(group.domain.displayName)
                }
            }
        }
        .listStyle(.inset)
        .frame(maxHeight: .infinity)
    }

    // MARK: - Draft Management

    /// Pull fresh values from the store for any rows the user has not
    /// touched. Preserves in-progress edits — without this, saving one row
    /// would clobber unsaved drafts in every other row when the store's
    /// optimistic update fires `onChange`.
    ///
    /// "Untouched" is defined as `draft == lastSyncedFromStore[id]` — the
    /// draft still matches the value we last accepted from the store.
    /// Comparing against the *new* persisted value would mis-flag external
    /// updates as user edits and let Save All overwrite newer daemon-side
    /// changes with stale drafts captured at sheet open.
    private func syncDraftsFromStore() {
        var nextDrafts: [String: CallSiteOverride] = drafts
        var nextSynced: [String: CallSiteOverride] = lastSyncedFromStore
        for entry in store.callSiteOverrides {
            let existingDraft = nextDrafts[entry.id]
            let baseline = nextSynced[entry.id]
            let untouched: Bool
            if let draft = existingDraft, let baseline = baseline {
                untouched = draft.provider == baseline.provider
                    && draft.model == baseline.model
                    && draft.profile == baseline.profile
            } else {
                // No baseline yet (first sync) or no draft yet — treat as
                // untouched so the row picks up the persisted value.
                untouched = true
            }
            if untouched {
                nextDrafts[entry.id] = entry
            }
            // Always advance the baseline so future external updates are
            // detected against the latest persisted value, even when the
            // user has unsaved edits we left alone.
            nextSynced[entry.id] = entry
        }
        drafts = nextDrafts
        lastSyncedFromStore = nextSynced
    }

    /// Returns a Binding into the draft cache, falling back to the catalog
    /// entry when the cache hasn't been populated yet (e.g. mid-render
    /// before `onAppear` fires).
    private func draftBinding(for id: String) -> Binding<CallSiteOverride> {
        Binding(
            get: {
                self.drafts[id]
                    ?? self.persistedById[id]
                    ?? CallSiteCatalog.byId[id]
                    ?? CallSiteOverride(id: id, displayName: id, domain: .utility)
            },
            set: { newValue in
                self.drafts[id] = newValue
            }
        )
    }

    // MARK: - Save / Clear / Reset

    private func save(id: String) {
        guard let draft = drafts[id] else { return }
        if draft.hasOverride {
            // Use replace (clear-then-set) so any stale daemon-side
            // leaves (maxTokens, effort, profile set externally, etc.)
            // are removed. The partial-update setCallSiteOverride
            // would silently retain fields the draft has nil'd.
            store.replaceCallSiteOverride(
                id,
                provider: draft.provider,
                model: draft.model,
                profile: draft.profile
            )
        } else {
            store.clearCallSiteOverride(id)
        }
        // The draft is now the new persisted state — bump the baseline so
        // any subsequent `onChange` from the store doesn't see a stale
        // baseline and re-flag the row as touched.
        lastSyncedFromStore[id] = drafts[id]
    }

    private func clear(id: String) {
        // Clear the local draft so the row collapses immediately, then push
        // the null-write to the daemon. The store updates its local cache
        // optimistically too, so `syncDraftsFromStore` won't bounce the value.
        drafts[id]?.provider = nil
        drafts[id]?.model = nil
        drafts[id]?.profile = nil
        store.clearCallSiteOverride(id)
        // Baseline now matches the cleared draft (no override).
        lastSyncedFromStore[id] = drafts[id]
    }

    private func saveAll() {
        // Pass only entries with active overrides — entries the user
        // toggled off must be omitted so `setCallSiteOverrides` routes
        // them through the entry-level null path that clears every leaf
        // (provider, model, profile, plus any maxTokens/effort/etc. that
        // may have been set elsewhere). Including a row with all-nil
        // fields would emit field-level nulls and leave hidden leaves.
        let merged = CallSiteCatalog.all.compactMap { entry -> CallSiteOverride? in
            guard let draft = drafts[entry.id], draft.hasOverride else { return nil }
            return draft
        }
        store.setCallSiteOverrides(merged)
        // After the batch lands, every draft's baseline is the draft itself
        // (the daemon now matches local). Refresh baselines for ALL catalog
        // entries — both the ones we sent and the implicitly-cleared ones.
        for entry in CallSiteCatalog.all {
            if let draft = drafts[entry.id] {
                lastSyncedFromStore[entry.id] = draft
            }
        }
    }

    private func resetAll() {
        // Reset every catalog entry locally and pass an empty list to the
        // store so `setCallSiteOverrides` nulls the entire `callSites.<id>`
        // entry on the daemon — clearing not just provider/model/profile
        // but also any advanced leaves (maxTokens, effort, temperature,
        // contextWindow) that may have been set via manual config edits.
        for entry in CallSiteCatalog.all {
            let cleared = CallSiteOverride(
                id: entry.id,
                displayName: entry.displayName,
                domain: entry.domain
            )
            drafts[entry.id] = cleared
            lastSyncedFromStore[entry.id] = cleared
        }
        store.setCallSiteOverrides([])
    }
}
