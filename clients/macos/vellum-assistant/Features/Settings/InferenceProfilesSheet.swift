import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Management sheet for the user's inference profiles. Lists every entry in
/// `store.profiles`, surfaces a "Managed" badge for profiles with
/// `source == "managed"`, and exposes Edit / Duplicate / Delete per row
/// plus a `+ New profile` toolbar action.
///
/// State ownership:
/// - The list mirrors `store.profiles` directly. Edits route through
///   `store.replaceProfile(name:fragment:)` which updates the published state
///   on success, so the sheet does not maintain a separate draft cache
///   for the list rows.
/// - The editor is presented modally over the sheet via the
///   `editorState` @State. The editor has its own draft binding —
///   committing pushes the fragment to the store and dismisses the editor.
/// - Delete blocked-by-references confirmation surfaces via `blockedState`.
///   The user can re-target every conflicting reference to a replacement
///   profile, which retries the delete after the patches land.
///
/// Managed profiles are read-only — Edit and Delete are disabled.
/// Users can duplicate a managed profile to create a customizable variant.
@MainActor
struct InferenceProfilesSheet: View {
    @ObservedObject var store: SettingsStore
    @Binding var isPresented: Bool

    @State private var editorState: EditorState?

    /// Local working copy for the active editor session. Bound into
    /// `InferenceProfileEditor` so the user's edits flow through without
    /// requiring the store to allocate intermediate state.
    @State private var editorDraft: InferenceProfile = InferenceProfile(name: "")

    /// Original profile name when an edit session begins. Drives the rename
    /// detection in `commitEditor` — when the user changes the name we
    /// delete the old key after the new one writes successfully.
    @State private var editorOriginalName: String?

    @State private var blockedState: BlockedDeleteState?

    /// Picked replacement profile name in the blocked-delete dialog. Drives
    /// the "Pick replacement" affordance.
    @State private var replacementSelection: String = ""

    /// Inline error surfaced when a save or delete fails. Cleared at the
    /// start of every action.
    @State private var actionError: String?

    /// Drag state for profile reordering. The row-level drop delegate uses
    /// this to render the insertion indicator and persist the new order.
    @State private var draggingProfileName: String?
    @State private var dropTargetProfileName: String?
    @State private var dropIndicatorAtBottom: Bool = false

    enum EditorState: Equatable {
        case create
        case edit(name: String)
        case duplicate(name: String)
        case view(name: String)
    }

    /// Conflict surface for a blocked delete. Mirrors
    /// `SettingsStore.DeleteProfileResult.blockedBy*` so the UI can render a
    /// per-shape message + remediation affordance.
    enum BlockedDeleteState: Equatable {
        case active(profileName: String, activeProfile: String)
        case callSites(profileName: String, callSiteIds: [String])
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            if editorState != nil {
                editorInline
            } else {
                header
                SettingsDivider()
                profilesList
                SettingsDivider()
                footer
            }
        }
        .frame(width: 560, height: 600)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .sheet(item: $blockedState) { _ in
            blockedDeleteSheet
        }
        .onChange(of: editorState) { _, newValue in
            if newValue == nil {
                editorDraft = InferenceProfile(name: "")
                editorOriginalName = nil
            }
        }
        .onChange(of: blockedState) { _, newValue in
            if newValue == nil {
                replacementSelection = ""
            }
        }
        .animation(VAnimation.fast, value: editorState != nil)
    }

    // MARK: - Header / Footer

    private var header: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Model Profiles")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Text("Bundle a provider and model into a named profile. Assign profiles to specific actions or swap between them when chatting.")
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
            VButton(label: "+ New Profile", style: .primary) {
                beginCreate()
            }
            if let actionError {
                Text(actionError)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
            Spacer()
            VButton(label: "Done", style: .outlined) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Profiles List

    private var profilesList: some View {
        List {
            if store.profiles.isEmpty {
                emptyState
                    .listRowSeparator(.hidden)
            } else {
                ForEach(store.profiles) { profile in
                    profileRow(profile)
                        .overlay(alignment: dropIndicatorAtBottom ? .bottom : .top) {
                            profileDropIndicator(for: profile)
                        }
                        .onDrop(
                            of: [.plainText],
                            delegate: InferenceProfileRowDropDelegate(
                                targetName: profile.name,
                                profiles: store.profiles,
                                draggingProfileName: $draggingProfileName,
                                dropTargetProfileName: $dropTargetProfileName,
                                dropIndicatorAtBottom: $dropIndicatorAtBottom,
                                onDrop: { sourceName, targetName, insertAfterTarget in
                                    Task {
                                        await reorderProfile(
                                            sourceName: sourceName,
                                            targetName: targetName,
                                            insertAfterTarget: insertAfterTarget
                                        )
                                    }
                                }
                            )
                        )
                        .contextMenu {
                            if profile.isManaged {
                                Button("View") { beginView(profile.name) }
                            } else {
                                Button("Edit") { beginEdit(profile.name) }
                            }
                            Button("Duplicate") { beginDuplicate(profile.name) }
                            Divider()
                            Button("Delete", role: .destructive) {
                                Task { await attemptDelete(profile.name) }
                            }
                            .disabled(profile.isManaged)
                        }
                }
            }
        }
        .listStyle(.inset)
        .frame(maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(alignment: .center, spacing: VSpacing.sm) {
            Text("No inference profiles configured")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
            Text("Add a profile to bundle a provider, model, and tuning under a name you can reuse across call sites and chats.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(VSpacing.xl)
    }

    /// Single row: display name + optional badge on the leading column,
    /// summary on the trailing column. Managed profiles disable Edit and
    /// Delete but keep Duplicate available.
    private func profileRow(_ profile: InferenceProfile) -> some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            VIconView(.gripVertical, size: 14)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 18, height: 28)
                .contentShape(Rectangle())
                .help("Drag to reorder")
                .accessibilityLabel("Reorder \(profile.displayName)")
                .pointerCursor()
                .onDrag {
                    draggingProfileName = profile.name
                    return NSItemProvider(object: profile.name as NSString)
                } preview: {
                    Text(profile.displayName)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .frame(width: 220, alignment: .leading)
                        .background(VColor.surfaceBase.opacity(0.94))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                HStack(spacing: VSpacing.xs) {
                    Text(profile.displayName)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    if profile.isManaged {
                        VBadge(label: "Vellum", tone: .neutral, emphasis: .subtle)
                            .help("Profiles managed by Vellum cannot be edited, but can be copied")
                    }
                }
                if let subtitle = profile.subtitle {
                    Text(subtitle)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                Text(InferenceProfilesSheet.summary(for: profile, store: store))
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            Spacer(minLength: 0)
            VButton(label: profile.isManaged ? "View" : "Edit", style: .ghost) {
                if profile.isManaged {
                    beginView(profile.name)
                } else {
                    beginEdit(profile.name)
                }
            }
        }
        .padding(.vertical, VSpacing.xs)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func profileDropIndicator(for profile: InferenceProfile) -> some View {
        if dropTargetProfileName == profile.name {
            Rectangle()
                .fill(VColor.borderActive)
                .frame(height: 2)
                .padding(.leading, 28)
        }
    }

    // MARK: - Inline Editor

    private var editorInline: some View {
        let isViewMode: Bool = {
            if case .view = editorState { return true }
            return false
        }()
        let isCreateMode: Bool = {
            switch editorState {
            case .create, .duplicate: return true
            default: return false
            }
        }()

        return InferenceProfileEditor(
            store: store,
            profile: $editorDraft,
            isReadOnly: isViewMode,
            isCreating: isCreateMode,
            onSave: {
                Task { await commitEditor() }
            },
            onSaveAs: isViewMode ? {
                guard let originalName = editorOriginalName else { return }
                beginDuplicate(originalName)
            } : nil,
            onCancel: {
                editorState = nil
            }
        )
    }

    // MARK: - Blocked Delete Sheet

    private var blockedDeleteSheet: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            blockedDeleteHeader
            blockedDeleteBody
            blockedDeleteActions
        }
        .padding(VSpacing.xl)
        .frame(width: 460)
        .background(VColor.surfaceOverlay)
    }

    private var blockedDeleteHeader: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Can't Delete Profile")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            Text(blockedSummary)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var blockedDeleteBody: some View {
        switch blockedState {
        case .active:
            EmptyView()
        case .callSites(_, let ids):
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Call sites using this profile:")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                ForEach(ids, id: \.self) { id in
                    Text("• \(callSiteDisplayName(id))")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentDefault)
                }
            }
        case .none:
            EmptyView()
        }
    }

    private var blockedDeleteActions: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if !replacementOptions.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Pick replacement")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Select a replacement profile\u{2026}",
                        selection: $replacementSelection,
                        options: replacementOptions.map { (label: $0, value: $0) }
                    )
                }
            }
            HStack(spacing: VSpacing.sm) {
                Spacer(minLength: 0)
                VButton(label: "Cancel", style: .ghost) {
                    blockedState = nil
                }
                VButton(
                    label: "Reassign and Delete",
                    style: .danger,
                    isDisabled: replacementSelection.isEmpty
                ) {
                    Task { await retargetAndDelete() }
                }
            }
        }
    }

    private var blockedSummary: String {
        switch blockedState {
        case .active(let profileName, let active):
            return "\"\(profileName)\" is the active profile (\"\(active)\"). Pick a different active profile or a replacement below to delete it."
        case .callSites(let profileName, let ids):
            let count = ids.count
            let suffix = count == 1 ? "call site" : "call sites"
            return "\"\(profileName)\" is in use by \(count) \(suffix). Pick a replacement to re-target the references, or cancel and clear them manually."
        case .none:
            return ""
        }
    }

    /// Replacement candidates are every profile except the one we're trying
    /// to delete. Order follows the user-controlled profile presentation
    /// order so the blocked-delete picker matches the rest of the UI.
    private var replacementOptions: [String] {
        let blockedName: String?
        switch blockedState {
        case .active(let name, _):
            blockedName = name
        case .callSites(let name, _):
            blockedName = name
        case .none:
            blockedName = nil
        }
        return store.profiles
            .map(\.name)
            .filter { $0 != blockedName }
    }

    // MARK: - Actions

    private func beginCreate() {
        actionError = nil
        let baseName = "new-profile"
        let uniqueName = uniqueProfileName(prefix: baseName)
        editorDraft = InferenceProfile(name: uniqueName)
        editorOriginalName = nil
        editorState = .create
    }

    private func beginView(_ name: String) {
        actionError = nil
        guard let existing = store.profiles.first(where: { $0.name == name }) else { return }
        editorDraft = existing
        editorOriginalName = name
        editorState = .view(name: name)
    }

    private func beginEdit(_ name: String) {
        actionError = nil
        guard let existing = store.profiles.first(where: { $0.name == name }) else { return }
        editorDraft = existing
        editorOriginalName = name
        editorState = .edit(name: name)
    }

    private func beginDuplicate(_ name: String) {
        actionError = nil
        guard let source = store.profiles.first(where: { $0.name == name }) else { return }
        var copy = source
        let sourceDisplayName = source.displayName
        copy.label = "\(sourceDisplayName) (copy)"
        copy.name = uniqueProfileName(prefix: "\(name)-copy")
        // Clear the managed source so the duplicate is treated as a
        // user-created profile and is fully editable.
        copy.source = nil
        editorDraft = copy
        editorOriginalName = nil
        editorState = .duplicate(name: name)
    }

    private func commitEditor() async {
        let draft = editorDraft
        let originalName = editorOriginalName
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        // Refuse to commit empty or whitespace-only names — the daemon
        // would accept them but the row would render unusably.
        guard !name.isEmpty else { return }

        // Reserve the call-site picker's Custom sentinel: a profile with
        // this name would collide with the synthetic option in
        // `CallSiteOverrideRow`'s VDropdown (same value identity), making
        // the profile unselectable as itself.
        if name == CallSiteOverrideRow.customSentinel {
            actionError = "\"\(name)\" is reserved. Pick a different name."
            return
        }

        // Defense-in-depth: the UI disables Edit for managed profiles, but
        // guard here in case the method is reached through an unexpected
        // path. The daemon also rejects writes to managed profiles.
        if let originalName,
           let existing = store.profiles.first(where: { $0.name == originalName }),
           existing.isManaged {
            actionError = "Managed profiles are read-only. Duplicate to customize."
            return
        }

        // Profile saves are upserts keyed by name, so committing under a
        // name that already belongs to a different profile would silently
        // overwrite that profile. Reject the collision and surface a
        // user-facing error before clobbering anything. The collision check
        // skips the case where we already saved under `name` on a previous
        // attempt — `editorOriginalName` is bumped to `name` post-save so a
        // retry after a partial-failure (e.g. retarget/delete threw) does
        // not see its own write as a foreign collision and trap the user.
        if name != originalName, store.profiles.contains(where: { $0.name == name }) {
            actionError = "A profile named \"\(name)\" already exists. Pick a different name."
            return
        }

        let replacingOrderName = originalName != nil && originalName != name ? originalName : nil
        let success = await store.replaceProfile(
            name: name,
            fragment: draft,
            replacingOrderName: replacingOrderName
        )
        guard success else {
            actionError = "Couldn't save profile. Please try again."
            return
        }

        // Renaming an existing profile: re-point references at the new
        // name, then drop the old key. Best-effort delete without
        // re-targeting silently fails when the original is the active
        // profile or referenced by call sites — `deleteProfile` returns
        // `.blockedBy*` in those cases — leaving a stale duplicate and
        // dangling references.
        if let originalName, originalName != name {
            // Bump editor anchor so a retry after a partial failure below
            // skips the collision check (the new-name profile now exists
            // because we just saved it). Without this, the user is trapped
            // in the editor with a misleading "already exists" error.
            editorOriginalName = name
            if store.activeProfile == originalName {
                let switched = await store.setActiveProfile(name)
                guard switched else {
                    actionError = "Saved \"\(name)\" but couldn't move the active profile pointer. Old entry \"\(originalName)\" left in place."
                    return
                }
            }
            let referencingCallSites = store.callSiteOverrides
                .filter { $0.profile == originalName }
                .map(\.id)
            // Use `setCallSiteOverride` (partial PATCH) rather than
            // `replaceCallSiteOverride` so per-call-site `provider`,
            // `model`, and non-UI leaves (`maxTokens`, `effort`,
            // `thinking`, `contextWindow`, …) survive the rename. We only
            // want the profile pointer to move.
            let retargetTasks = referencingCallSites.map { id in
                store.setCallSiteOverride(id, profile: name)
            }
            for task in retargetTasks {
                guard await task.value else {
                    actionError = "Saved \"\(name)\" but couldn't re-target call-site overrides. Old entry \"\(originalName)\" left in place."
                    return
                }
            }
            let deleteResult = await store.deleteProfile(name: originalName)
            guard case .deleted = deleteResult else {
                actionError = "Saved \"\(name)\" but couldn't remove old entry \"\(originalName)\". Delete it manually."
                return
            }
        }

        editorState = nil
    }

    private func reorderProfile(
        sourceName: String,
        targetName: String,
        insertAfterTarget: Bool
    ) async {
        actionError = nil
        let success = await store.moveProfile(
            sourceName: sourceName,
            targetName: targetName,
            insertAfterTarget: insertAfterTarget
        )
        if !success {
            actionError = "Couldn't reorder profiles. Please try again."
        }
    }

    private func attemptDelete(_ name: String) async {
        actionError = nil
        let result = await store.deleteProfile(name: name)
        switch result {
        case .deleted:
            break
        case .blockedByActive(let active):
            blockedState = .active(profileName: name, activeProfile: active)
        case .blockedByCallSites(let ids):
            blockedState = .callSites(profileName: name, callSiteIds: ids)
        case .blockedByManaged:
            actionError = "Managed profiles are read-only. Duplicate to customize."
        case .failed:
            actionError = "Couldn't delete \"\(name)\". Please try again."
        }
    }

    /// Re-targets every conflicting reference to `replacementSelection`,
    /// then retries the delete. Used by the "Pick replacement" affordance
    /// in the blocked-delete sheet.
    private func retargetAndDelete() async {
        guard !replacementSelection.isEmpty,
              let blocked = blockedState else { return }
        let replacement = replacementSelection
        let blockedName: String
        switch blocked {
        case .active(let name, _):
            blockedName = name
            // Re-target the active profile pointer.
            let switched = await store.setActiveProfile(replacement)
            guard switched else {
                actionError = "Couldn't re-target active profile. \"\(name)\" not deleted."
                blockedState = nil
                return
            }
        case .callSites(let name, let ids):
            blockedName = name
            // Issue all reassignments concurrently, then await each so a
            // failure aborts before the delete. `setCallSiteOverride`
            // updates the local cache synchronously, which means the
            // local reference scan in `deleteProfile` would otherwise
            // pass even when the daemon-side PATCH failed — leaving call
            // sites pointing at a deleted profile. `setCallSiteOverride`
            // (partial PATCH) is used over `replaceCallSiteOverride` so
            // per-call-site `provider`, `model`, and non-UI leaves
            // (`maxTokens`, `effort`, `thinking`, `contextWindow`, …)
            // are preserved — only the profile pointer should move.
            let tasks = ids.map { id in
                store.setCallSiteOverride(id, profile: replacement)
            }
            for task in tasks {
                let success = await task.value
                guard success else {
                    actionError = "Couldn't re-target call-site overrides. \"\(name)\" not deleted."
                    blockedState = nil
                    return
                }
            }
        }
        // Dismiss the blocked sheet first so the retry can re-present it
        // if needed (otherwise SwiftUI would suppress a second sheet
        // presentation).
        blockedState = nil
        // Retry the delete now that references are pointing at the
        // replacement.
        await attemptDelete(blockedName)
    }

    /// Generates a name that doesn't collide with any existing profile.
    /// `"new-profile"` becomes `"new-profile-2"`, `"new-profile-3"`, etc.
    static func nextAvailableProfileName(prefix: String, existing: Set<String>) -> String {
        if !existing.contains(prefix) {
            return prefix
        }
        var suffix = 2
        while existing.contains("\(prefix)-\(suffix)") {
            suffix += 1
        }
        return "\(prefix)-\(suffix)"
    }

    private func uniqueProfileName(prefix: String) -> String {
        Self.nextAvailableProfileName(
            prefix: prefix,
            existing: Set(store.profiles.map(\.name))
        )
    }

    /// Resolves a callsite ID to its catalog display name when known,
    /// falling back to the raw ID if the catalog has no entry.
    private func callSiteDisplayName(_ id: String) -> String {
        CallSiteCatalog.byId[id]?.displayName ?? id
    }

    // MARK: - Static Helpers

    /// Composes the row's summary line. Resolves provider+model display
    /// names against the store's catalog when present so the user sees the
    /// human-readable label rather than the wire ID, then appends relevant
    /// effort and thinking summaries when they're set on the fragment.
    static func summary(for profile: InferenceProfile, store: SettingsStore) -> String {
        var pieces: [String] = []
        if let provider = profile.provider, !provider.isEmpty {
            if let model = profile.model, !model.isEmpty {
                let models = store.dynamicProviderModels(provider)
                let label = models.first(where: { $0.id == model })?.displayName ?? model
                pieces.append(label)
            } else {
                pieces.append(store.dynamicProviderDisplayName(provider))
            }
        } else if let model = profile.model, !model.isEmpty {
            pieces.append(model)
        }
        let provider = profile.provider ?? ""
        let model = profile.model ?? ""
        let visibility = InferenceProfileParameterVisibility.resolve(
            provider: profile.provider,
            model: profile.model,
            isKnownModel: store.dynamicProviderModels(provider).contains { $0.id == model },
            modelEntry: LLMProviderRegistry.model(provider: provider, id: model)
        )
        if visibility.effort, let effort = profile.effort, !effort.isEmpty {
            pieces.append("\(effort) effort")
        }
        if visibility.maxTokens, let maxTokens = profile.maxTokens {
            pieces.append("\(InferenceProfileEditor.formattedTokenCount(maxTokens)) output")
        }
        if let contextMax = profile.contextWindowMaxInputTokens {
            pieces.append("\(InferenceProfileEditor.formattedTokenCount(contextMax)) context")
        }
        if visibility.thinking, let thinkingEnabled = profile.thinkingEnabled {
            pieces.append("thinking \(thinkingEnabled ? "on" : "off")")
        }
        if pieces.isEmpty {
            return "Inherits defaults"
        }
        return pieces.joined(separator: " \u{00B7} ")
    }
}

// MARK: - Identifiable Conformance

/// `EditorState` is used as an `Identifiable` value via `.sheet(item:)`.
/// Each variant maps to a stable string id so SwiftUI can drive the sheet's
/// presentation lifecycle.
extension InferenceProfilesSheet.EditorState: Identifiable {
    var id: String {
        switch self {
        case .create:
            return "create"
        case .edit(let name):
            return "edit:\(name)"
        case .duplicate(let name):
            return "duplicate:\(name)"
        case .view(let name):
            return "view:\(name)"
        }
    }
}

extension InferenceProfilesSheet.BlockedDeleteState: Identifiable {
    var id: String {
        switch self {
        case .active(let name, _):
            return "active:\(name)"
        case .callSites(let name, _):
            return "callSites:\(name)"
        }
    }
}

private struct InferenceProfileRowDropDelegate: DropDelegate {
    let targetName: String
    let profiles: [InferenceProfile]
    @Binding var draggingProfileName: String?
    @Binding var dropTargetProfileName: String?
    @Binding var dropIndicatorAtBottom: Bool
    let onDrop: (String, String, Bool) -> Void

    func validateDrop(info: DropInfo) -> Bool {
        guard let sourceName = draggingProfileName,
              sourceName != targetName,
              profiles.contains(where: { $0.name == sourceName }),
              profiles.contains(where: { $0.name == targetName }) else {
            return false
        }
        return info.hasItemsConforming(to: [.plainText])
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let sourceName = draggingProfileName,
              sourceName != targetName else { return }
        dropTargetProfileName = targetName
        let sourceIndex = profiles.firstIndex(where: { $0.name == sourceName }) ?? 0
        let targetIndex = profiles.firstIndex(where: { $0.name == targetName }) ?? 0
        dropIndicatorAtBottom = sourceIndex < targetIndex
    }

    func dropExited(info: DropInfo) {
        if dropTargetProfileName == targetName {
            dropTargetProfileName = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        guard let sourceName = draggingProfileName,
              sourceName != targetName else {
            draggingProfileName = nil
            dropTargetProfileName = nil
            return false
        }
        let insertAfterTarget = dropIndicatorAtBottom
        draggingProfileName = nil
        dropTargetProfileName = nil
        onDrop(sourceName, targetName, insertAfterTarget)
        return true
    }
}
