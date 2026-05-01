import SwiftUI
import VellumAssistantShared

/// Editable sheet listing every call site in the catalog, grouped by
/// `CallSiteDomain`. Each row exposes an "Override default" toggle plus
/// provider/model pickers. Nothing persists until the user clicks Save
/// in the footer. Cancel discards all unsaved changes.
@MainActor
struct CallSiteOverridesSheet: View {
    @ObservedObject var store: SettingsStore
    @Binding var isPresented: Bool

    /// Working copies keyed by call-site ID. Edits live here until the user
    /// hits Save in the footer. Drafts are seeded from
    /// `store.callSiteOverrides` on appear and re-synced when the store
    /// changes externally.
    @State private var drafts: [String: CallSiteOverride] = [:]

    /// Snapshot of the last persisted value we synced into each draft. Used
    /// by `syncDraftsFromStore` to distinguish "user has unsaved edits"
    /// (draft != lastSynced) from "store changed externally and we need to
    /// pick up the new value" (draft == lastSynced but lastSynced != new
    /// persisted). Without this, we would compare the draft to the *new*
    /// persisted value and incorrectly flag externally-updated rows as
    /// touched, which would let Save clobber newer daemon-side updates.
    @State private var lastSyncedFromStore: [String: CallSiteOverride] = [:]

    /// Shows the destructive confirmation for Reset to Defaults.
    @State private var showResetConfirmation = false

    /// Search query for filtering the task list.
    @State private var searchQuery = ""

    private let catalog = CallSiteCatalog.shared

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

    /// Catalog entries grouped by domain in catalog order, filtered by the
    /// search query. Matches against the entry's display name and the
    /// domain's display name. Empty groups are omitted.
    private var filteredEntriesByDomain: [(domain: CallSiteDomain, entries: [CallSiteOverride])] {
        let query = searchQuery.trimmingCharacters(in: .whitespaces).lowercased()
        var grouped: [String: [CallSiteOverride]] = [:]
        for entry in catalog.callSites {
            if !query.isEmpty {
                let matchesName = entry.displayName.lowercased().contains(query)
                let matchesDescription = entry.callSiteDescription.lowercased().contains(query)
                let domainDisplayName = catalog.domains.first { $0.id == entry.domain }?.displayName ?? entry.domain
                let matchesDomain = domainDisplayName.lowercased().contains(query)
                let matchesId = entry.id.lowercased().contains(query)
                guard matchesName || matchesDescription || matchesDomain || matchesId else { continue }
            }
            grouped[entry.domain, default: []].append(entry)
        }
        return catalog.domains.compactMap { domain in
            guard let entries = grouped[domain.id], !entries.isEmpty else { return nil }
            return (domain: domain, entries: entries)
        }
    }

    /// True when at least one draft differs from the persisted value.
    /// Drives the enabled state of the footer Save button.
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

    /// True when any draft in Custom mode has a validation error (e.g.
    /// provider set but no model). Blocks the footer Save button.
    private var hasAnyValidationError: Bool {
        for (_, draft) in drafts {
            guard CallSiteOverrideRow.profilePickerValue(for: draft) == CallSiteOverrideRow.customSentinel else { continue }
            let provider = draft.provider ?? ""
            let model = draft.model ?? ""
            if !provider.isEmpty && model.isEmpty { return true }
        }
        return false
    }

    /// True when at least one persisted entry has any override set. Drives
    /// the visibility of the footer "Reset to Defaults" button.
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

            searchBar

            overridesList

            SettingsDivider()
            footer
        }
        .frame(width: 560, height: 540)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear { syncDraftsFromStore() }
        .task {
            // Re-attempt on open if a prior fetch failed (e.g. daemon was
            // restarted since the last time the sheet was shown).
            let shouldForce = catalog.loadFailed && catalog.callSites.isEmpty
            await store.ensureCallSiteCatalogLoaded(force: shouldForce)
        }
        .onChange(of: store.callSiteOverrides) { _, _ in
            syncDraftsFromStore()
        }
        .confirmationDialog(
            "Reset to Defaults",
            isPresented: $showResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reset to Defaults", role: .destructive) {
                resetAll()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every task override will be reset and will follow your active profile. This cannot be undone.")
        }
    }

    // MARK: - Header / Footer

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Action Overrides")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            Text("Customize which model profile specific actions should use. Uses your default profile if no override is set.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
    }

    private var footer: some View {
        HStack(spacing: VSpacing.sm) {
            if hasAnyPersistedOverride {
                VButton(label: "Reset to Defaults", style: .dangerOutline) {
                    showResetConfirmation = true
                }
            }
            Spacer(minLength: 0)
            VButton(label: "Cancel", style: .outlined) {
                isPresented = false
            }
            VButton(label: "Save", style: .primary, isDisabled: !hasUnsavedDrafts || hasAnyValidationError) {
                saveAll()
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    private var searchBar: some View {
        VTextField(
            placeholder: "Search actions\u{2026}",
            text: $searchQuery,
            leadingIcon: VIcon.search.rawValue,
            size: .small
        )
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Overrides List

    private var overridesList: some View {
        Group {
            if catalog.isFetching && catalog.callSites.isEmpty {
                catalogLoadingState
            } else if catalog.loadFailed && catalog.callSites.isEmpty {
                catalogErrorState
            } else {
                catalogList
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var catalogLoadingState: some View {
        VStack {
            Spacer()
            ProgressView()
            Spacer()
        }
    }

    private var catalogErrorState: some View {
        VStack(spacing: VSpacing.sm) {
            Spacer()
            Text("Couldn't load actions")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
            Text("Make sure your assistant is running and up to date.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentTertiary)
                .multilineTextAlignment(.center)
            VButton(label: "Retry", style: .outlined) {
                Task { await store.ensureCallSiteCatalogLoaded(force: true) }
            }
            .padding(.top, VSpacing.xs)
            Spacer()
        }
        .padding(.horizontal, VSpacing.lg)
    }

    private var catalogList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                let filtered = filteredEntriesByDomain
                ForEach(Array(filtered.enumerated()), id: \.element.domain.id) { index, group in
                    Text(group.domain.displayName)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .textCase(.uppercase)
                        .padding(.horizontal, VSpacing.lg)
                        .padding(.top, index == 0 ? VSpacing.sm : VSpacing.xl)
                        .padding(.bottom, VSpacing.xs)

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
                            profiles: store.profiles
                        )
                        .padding(.horizontal, VSpacing.lg)

                        if entry.id != group.entries.last?.id {
                            SettingsDivider()
                                .padding(.horizontal, VSpacing.lg)
                        }
                    }
                }
            }
        }
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
    /// updates as user edits and let Save overwrite newer daemon-side
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
                    ?? CallSiteOverride(id: id, displayName: id, domain: "skills")
            },
            set: { newValue in
                self.drafts[id] = newValue
            }
        )
    }

    // MARK: - Save / Reset

    private func saveAll() {
        // Pass only entries with active overrides — entries the user
        // toggled off must be omitted so `setCallSiteOverrides` routes
        // them through the entry-level null path that clears every leaf
        // (provider, model, profile, plus any maxTokens/effort/etc. that
        // may have been set elsewhere). Including a row with all-nil
        // fields would emit field-level nulls and leave hidden leaves.
        let merged = catalog.callSites.compactMap { entry -> CallSiteOverride? in
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
        for entry in catalog.callSites {
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
