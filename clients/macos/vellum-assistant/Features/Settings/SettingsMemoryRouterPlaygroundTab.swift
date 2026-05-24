import SwiftUI
import VellumAssistantShared

/// Settings tab for the v4 memory router simulator. Lets a developer
/// preview which concept pages the router would select for a given query
/// under custom `tier1_size`, `tier2_size`, and `batch_size` overrides —
/// without touching the live EMA event log or activation log.
///
/// Two independent result panes share one query input. Each pane carries
/// its own override fields and runs its own simulation; after both have
/// run, slugs are color-coded by whether they appear in both panes or
/// only one.
///
/// Gated by:
///   1. `settings-developer-nav` (developer-nav visibility)
///   2. `memory-router-playground` (this tab)
///   3. `DevModeManager.shared.isDevMode`
@MainActor
struct SettingsMemoryRouterPlaygroundTab: View {
    let store: SettingsStore
    let showToast: (String, ToastInfo.Style) -> Void
    let onClose: () -> Void

    private let client = MemoryRouterPlaygroundClient()

    // Conversational context — shared between both panes so the comparison
    // is about config knobs, not about which scenario the router saw. The
    // list is rendered oldest-first; the LAST pair's `userMessage` is the
    // just-arrived turn the router is routing for.
    @State private var nowText: String = ""
    @State private var recentTurnPairs: [RecentTurnPair] = [
        RecentTurnPair(assistantMessage: "", userMessage: "")
    ]
    /// Echo of the user message used for the most recent successful run,
    /// surfaced in the per-pane summary card.
    @State private var lastUserMessage: String = ""
    /// Tracks whether the live NOW.md fetch has already seeded `nowText`.
    /// Subsequent successful fetches do NOT overwrite the field — the user
    /// owns it after first load (or after their first edit).
    @State private var nowTextSeeded: Bool = false
    @State private var paneA = PaneState()
    @State private var paneB = PaneState()
    @State private var availableProfiles: [String] = []
    @State private var activeProfile: String?
    @State private var defaultPromptTemplate: String = ""

    enum PaneId { case a, b }

    struct PaneState {
        var tier1: String = ""
        var tier2: String = ""
        var batch: String = ""
        /// Empty string means "inherit active profile".
        var profile: String = ""
        /// Empty string means "use bundled template".
        var customPrompt: String = ""
        /// Disclosure state for the per-pane prompt editor.
        var showPromptEditor: Bool = false
        var isRunning: Bool = false
        var validationError: String?
        var clientError: String?
        var lastResult: MemoryRouterSimulateResponse?
        /// Pretty-printed request body from the most recent successful run.
        var rawRequest: String?
        /// Pretty-printed response body from the most recent successful run.
        var rawResponse: String?
        /// Disclosure state for the raw API exchange panel.
        var showRawExchange: Bool = false
    }

    enum SlugDiff { case both, onlyHere }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                header
                contextCard
                runBothRow
                if paneA.lastResult != nil && paneB.lastResult != nil {
                    diffLegend
                }
                HStack(alignment: .top, spacing: VSpacing.md) {
                    paneColumn(pane: .a)
                    paneColumn(pane: .b)
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task {
            await loadInitialContext()
        }
    }

    private func loadInitialContext() async {
        do {
            let response = try await client.fetchProfiles()
            availableProfiles = response.profiles
            activeProfile = response.activeProfile
        } catch {
            // Best-effort — leave the pickers empty. The user can still type
            // an override into config.json directly or wait until profiles
            // load on a later view appearance.
        }
        if defaultPromptTemplate.isEmpty {
            if let template = try? await client.fetchDefaultRouterPrompt() {
                defaultPromptTemplate = template
            }
        }
        if !nowTextSeeded {
            if let now = try? await client.fetchCurrentNowText() {
                nowText = now
                nowTextSeeded = true
            }
        }
    }

    private func reloadLiveNowText() {
        Task {
            if let now = try? await client.fetchCurrentNowText() {
                nowText = now
                nowTextSeeded = true
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Memory Router Playground")
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentEmphasized)
            Text(
                "Dry-run the v4 router with custom tier/batch overrides. Read-only — no rows are written to memory_v2_injection_events or memory_v2_activation_logs, and no activation state is mutated. Leave an override blank to inherit the live config value; enter 'null' to explicitly disable a tier."
            )
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Shared conversational context

    private var contextCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Conversational context (shared by both panes)")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            contextField(
                label: "<now> block",
                binding: $nowText,
                minHeight: 140,
                monospace: true,
                trailing: AnyView(
                    Button("Reload live NOW.md") {
                        reloadLiveNowText()
                    }
                    .buttonStyle(.plain)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                )
            )
            HStack {
                Text("Recent (assistant, user) pairs · oldest first")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Spacer()
                Button("+ Add older pair") {
                    recentTurnPairs.insert(
                        RecentTurnPair(assistantMessage: "", userMessage: ""),
                        at: 0
                    )
                }
                .buttonStyle(.plain)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            }
            ForEach(recentTurnPairs.indices, id: \.self) { index in
                pairCard(index: index)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    @ViewBuilder
    private func pairCard(index: Int) -> some View {
        let isLast = index == recentTurnPairs.count - 1
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Text("Pair \(index + 1) of \(recentTurnPairs.count)\(isLast ? " · most recent" : "")")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Spacer()
                if !isLast {
                    // Refuse to drop the most recent pair — its `userMessage`
                    // is the just-arrived turn the router routes against.
                    Button("Remove") {
                        recentTurnPairs.remove(at: index)
                    }
                    .buttonStyle(.plain)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                }
            }
            contextField(
                label: "[assistant]: reply",
                binding: assistantBinding(index: index),
                minHeight: 80,
                monospace: false,
                trailing: nil
            )
            contextField(
                label: isLast ? "Just-arrived [user]: message *" : "[user]: message",
                binding: userBinding(index: index),
                minHeight: 80,
                monospace: false,
                trailing: nil
            )
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func assistantBinding(index: Int) -> Binding<String> {
        Binding(
            get: { recentTurnPairs[index].assistantMessage },
            set: { newValue in
                recentTurnPairs[index] = RecentTurnPair(
                    assistantMessage: newValue,
                    userMessage: recentTurnPairs[index].userMessage
                )
            }
        )
    }

    private func userBinding(index: Int) -> Binding<String> {
        Binding(
            get: { recentTurnPairs[index].userMessage },
            set: { newValue in
                recentTurnPairs[index] = RecentTurnPair(
                    assistantMessage: recentTurnPairs[index].assistantMessage,
                    userMessage: newValue
                )
            }
        )
    }

    private func contextField(
        label: String,
        binding: Binding<String>,
        minHeight: CGFloat,
        monospace: Bool,
        trailing: AnyView?
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Text(label)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Spacer()
                if let trailing = trailing {
                    trailing
                }
            }
            TextEditor(text: binding)
                .font(monospace
                    ? .system(.body, design: .monospaced)
                    : VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .scrollContentBackground(.hidden)
                .padding(VSpacing.sm)
                .frame(minHeight: minHeight)
                .background(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }

    private var runBothRow: some View {
        HStack {
            Spacer()
            VButton(
                label: (paneA.isRunning || paneB.isRunning) ? "Running…" : "Run both",
                style: .primary,
                isDisabled: !canRunBoth
            ) {
                runPane(.a)
                runPane(.b)
            }
        }
    }

    private var diffLegend: some View {
        HStack(spacing: VSpacing.md) {
            legendItem(marker: "●", color: VColor.contentDefault, label: "in both")
            legendItem(marker: "◆", color: paneAccentColor(.a), label: "A only")
            legendItem(marker: "◇", color: paneAccentColor(.b), label: "B only")
            Spacer()
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func legendItem(marker: String, color: Color, label: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(marker).foregroundStyle(color)
            Text(label).foregroundStyle(VColor.contentSecondary)
        }
        .font(VFont.labelDefault)
    }

    // MARK: - Per-pane column

    @ViewBuilder
    private func paneColumn(pane: PaneId) -> some View {
        let state = paneState(pane)
        let otherState = paneState(otherPane(pane))
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Pane \(paneLabel(pane))")
                .font(VFont.titleSmall)
                .foregroundStyle(paneAccentColor(pane))
            paneFormCard(pane: pane)
            if let err = state.validationError ?? state.clientError {
                errorBanner(err)
            }
            if let result = state.lastResult {
                paneResultSection(
                    result: result,
                    pane: pane,
                    otherResult: otherState.lastResult
                )
                if let req = state.rawRequest, let resp = state.rawResponse {
                    rawExchangeCard(
                        pane: pane,
                        rawRequest: req,
                        rawResponse: resp
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rawExchangeCard(
        pane: PaneId,
        rawRequest: String,
        rawResponse: String
    ) -> some View {
        let state = paneState(pane)
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            Button {
                toggleRawExchange(pane)
            } label: {
                Text("\(state.showRawExchange ? "▾" : "▸") Raw API exchange")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            if state.showRawExchange {
                rawExchangeBlock(label: "Request (Pane \(paneLabel(pane)))", body: rawRequest)
                rawExchangeBlock(label: "Response (Pane \(paneLabel(pane)))", body: rawResponse)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func rawExchangeBlock(label: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            ScrollView(.vertical) {
                Text(body.isEmpty ? "(empty)" : body)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(VSpacing.sm)
            }
            .frame(minHeight: 120, maxHeight: 320)
            .background(VColor.surfaceBase)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }

    private func paneFormCard(pane: PaneId) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(alignment: .top, spacing: VSpacing.sm) {
                overrideField(label: "tier1_size", binding: tier1Binding(pane))
                overrideField(label: "tier2_size", binding: tier2Binding(pane))
                overrideField(label: "batch_size", binding: batchBinding(pane))
            }
            profileField(pane: pane)
            promptEditorField(pane: pane)
            HStack {
                Spacer()
                VButton(
                    label: paneState(pane).isRunning ? "Running…" : "Run \(paneLabel(pane))",
                    style: .outlined,
                    isDisabled: !canRun(pane)
                ) {
                    runPane(pane)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func promptEditorField(pane: PaneId) -> some View {
        let state = paneState(pane)
        let usingCustom = !state.customPrompt
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
        return VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Button {
                    showPromptEditorToggle(pane)
                } label: {
                    Text("\(state.showPromptEditor ? "▾" : "▸") System prompt (\(usingCustom ? "custom" : "bundled"))")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                Spacer()
                if state.showPromptEditor {
                    Button("Load default") {
                        setCustomPrompt(pane: pane, value: defaultPromptTemplate)
                    }
                    .buttonStyle(.plain)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .disabled(defaultPromptTemplate.isEmpty)
                    Button("Reset") {
                        setCustomPrompt(pane: pane, value: "")
                    }
                    .buttonStyle(.plain)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .disabled(!usingCustom)
                }
            }
            if state.showPromptEditor {
                TextEditor(text: customPromptBinding(pane))
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .frame(minHeight: 180)
                    .background(VColor.surfaceBase)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
        }
    }

    private func profileField(pane: PaneId) -> some View {
        let inheritLabel: String
        if let active = activeProfile, !active.isEmpty {
            inheritLabel = "inherit active (\(active))"
        } else {
            inheritLabel = "inherit active"
        }
        return VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("llm.profiles override")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            Picker("", selection: profileBinding(pane)) {
                Text(inheritLabel).tag("")
                ForEach(availableProfiles, id: \.self) { name in
                    Text(name).tag(name)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func overrideField(label: String, binding: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            TextField("inherit", text: binding)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)
                .background(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Result section

    @ViewBuilder
    private func paneResultSection(
        result: MemoryRouterSimulateResponse,
        pane: PaneId,
        otherResult: MemoryRouterSimulateResponse?
    ) -> some View {
        let diff = classifySlugs(own: result, other: otherResult)
        summaryCard(result: result, otherResult: otherResult, diff: diff)
        configCard(result)
        if let reason = result.failureReason {
            errorBanner("Router failure: \(reason)")
        }
        let groups = groupSlugsBySource(result)
        if groups.isEmpty {
            emptyResultCard
        } else {
            ForEach(groups, id: \.source) { group in
                tierCard(group: group, scores: result.scores, pane: pane, diff: diff)
            }
        }
    }

    private func summaryCard(
        result: MemoryRouterSimulateResponse,
        otherResult: MemoryRouterSimulateResponse?,
        diff: [String: SlugDiff]
    ) -> some View {
        let counts = countDiff(diff)
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Summary")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            metaRow(label: "User message", value: lastUserMessage)
            metaRow(
                label: "Total candidate pages",
                value: "\(result.totalCandidatePages)"
            )
            metaRow(
                label: "Selected",
                value: "\(result.selectedSlugs.count)  (live max_page_ids: \(result.effectiveConfig.maxPageIds))"
            )
            if otherResult != nil {
                metaRow(
                    label: "Diff",
                    value: "\(counts.shared) shared · \(counts.unique) unique to this pane"
                )
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func configCard(_ result: MemoryRouterSimulateResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Effective config")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            metaRow(
                label: "tier1_size",
                value: formatKnob(
                    effective: result.effectiveConfig.tier1Size,
                    override: result.overrides.tier1Size
                )
            )
            metaRow(
                label: "tier2_size",
                value: formatKnob(
                    effective: result.effectiveConfig.tier2Size,
                    override: result.overrides.tier2Size
                )
            )
            metaRow(
                label: "batch_size",
                value: formatKnob(
                    effective: result.effectiveConfig.batchSize,
                    override: result.overrides.batchSize
                )
            )
            metaRow(
                label: "max_page_ids",
                value: "\(result.effectiveConfig.maxPageIds)"
            )
            metaRow(
                label: "llm.profiles override",
                value: result.profileOverride.map { "\($0)  (override)" } ?? "inherit active"
            )
            metaRow(
                label: "system prompt",
                value: result.routerPromptOverridden ? "custom" : "bundled"
            )
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func tierCard(
        group: SourceGroup,
        scores: [String: Double],
        pane: PaneId,
        diff: [String: SlugDiff]
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                Text(formatSourceLabel(group.source))
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                Text("\(group.slugs.count) \(group.slugs.count == 1 ? "page" : "pages")")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(group.slugs, id: \.self) { slug in
                    slugRow(slug: slug, pane: pane, diff: diff, source: group.source, scores: scores)
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func slugRow(
        slug: String,
        pane: PaneId,
        diff: [String: SlugDiff],
        source: String,
        scores: [String: Double]
    ) -> some View {
        let cls = diff[slug] ?? .onlyHere
        let color: Color = cls == .both ? VColor.contentDefault : paneAccentColor(pane)
        let marker: String = cls == .both ? "●" : (pane == .a ? "◆" : "◇")
        return HStack(alignment: .firstTextBaseline, spacing: VSpacing.xs) {
            Text(marker).foregroundStyle(color)
            Text(slug)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(color)
                .textSelection(.enabled)
            Spacer()
            if source == "tier2" {
                Text("EMA \(formatScore(scores[slug] ?? 0))")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
    }

    private var emptyResultCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("No pages selected")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            Text(
                "The router returned an empty selection. Try a more specific query, or relax the override values."
            )
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func errorBanner(_ message: String) -> some View {
        Text(message)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.systemNegativeStrong)
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    // MARK: - Pane state helpers

    private func paneState(_ pane: PaneId) -> PaneState {
        pane == .a ? paneA : paneB
    }

    private func otherPane(_ pane: PaneId) -> PaneId {
        pane == .a ? .b : .a
    }

    private func paneLabel(_ pane: PaneId) -> String {
        pane == .a ? "A" : "B"
    }

    private func paneAccentColor(_ pane: PaneId) -> Color {
        pane == .a ? VColor.systemMidStrong : VColor.primaryBase
    }

    private func tier1Binding(_ pane: PaneId) -> Binding<String> {
        pane == .a ? $paneA.tier1 : $paneB.tier1
    }

    private func tier2Binding(_ pane: PaneId) -> Binding<String> {
        pane == .a ? $paneA.tier2 : $paneB.tier2
    }

    private func batchBinding(_ pane: PaneId) -> Binding<String> {
        pane == .a ? $paneA.batch : $paneB.batch
    }

    private func profileBinding(_ pane: PaneId) -> Binding<String> {
        pane == .a ? $paneA.profile : $paneB.profile
    }

    private func customPromptBinding(_ pane: PaneId) -> Binding<String> {
        pane == .a ? $paneA.customPrompt : $paneB.customPrompt
    }

    private func setCustomPrompt(pane: PaneId, value: String) {
        switch pane {
        case .a: paneA.customPrompt = value
        case .b: paneB.customPrompt = value
        }
    }

    private func showPromptEditorToggle(_ pane: PaneId) {
        switch pane {
        case .a: paneA.showPromptEditor.toggle()
        case .b: paneB.showPromptEditor.toggle()
        }
    }

    private var lastUserMessageDraft: String {
        recentTurnPairs.last?.userMessage ?? ""
    }

    private func canRun(_ pane: PaneId) -> Bool {
        !lastUserMessageDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty && !paneState(pane).isRunning
    }

    private var canRunBoth: Bool {
        !lastUserMessageDraft.trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty && !paneA.isRunning && !paneB.isRunning
    }

    // MARK: - Run

    private func runPane(_ pane: PaneId) {
        // Clear per-pane error state on entry.
        switch pane {
        case .a:
            paneA.validationError = nil
            paneA.clientError = nil
        case .b:
            paneB.validationError = nil
            paneB.clientError = nil
        }

        let trimmedUser = lastUserMessageDraft.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !trimmedUser.isEmpty else { return }

        let state = paneState(pane)
        let tier1Override: MemoryRouterOverride
        let tier2Override: MemoryRouterOverride
        let batchOverride: MemoryRouterOverride
        do {
            tier1Override = try parseOverride(field: "tier1_size", raw: state.tier1)
            tier2Override = try parseOverride(field: "tier2_size", raw: state.tier2)
            batchOverride = try parseOverride(field: "batch_size", raw: state.batch)
        } catch {
            setValidationError(pane: pane, message: error.localizedDescription)
            return
        }

        let profileTrimmed = state.profile.trimmingCharacters(in: .whitespacesAndNewlines)
        let profileOverride: String? = profileTrimmed.isEmpty ? nil : profileTrimmed
        let promptTrimmed = state.customPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let routerPromptOverride: String? = promptTrimmed.isEmpty ? nil : state.customPrompt
        // Trim the most recent pair's userMessage to avoid sending leading/
        // trailing whitespace on the just-arrived turn; older pairs go on
        // the wire verbatim so pasted transcripts keep their formatting.
        var wirePairs = recentTurnPairs
        if let last = wirePairs.last {
            wirePairs[wirePairs.count - 1] = RecentTurnPair(
                assistantMessage: last.assistantMessage,
                userMessage: trimmedUser
            )
        }
        let input = MemoryRouterSimulateInput(
            recentTurnPairs: wirePairs,
            nowText: nowText,
            tier1Size: tier1Override,
            tier2Size: tier2Override,
            batchSize: batchOverride,
            profileOverride: profileOverride,
            routerPromptOverride: routerPromptOverride
        )

        setIsRunning(pane: pane, value: true)
        lastUserMessage = trimmedUser
        Task {
            defer { setIsRunning(pane: pane, value: false) }
            do {
                let result = try await client.simulate(input: input)
                setLastResult(pane: pane, result: result.response)
                setRawExchange(
                    pane: pane,
                    request: result.rawRequest,
                    response: result.rawResponse
                )
                setClientError(pane: pane, message: nil)
            } catch MemoryRouterPlaygroundError.memoryV2Disabled {
                setClientError(
                    pane: pane,
                    message: "Memory v2 is not enabled on this assistant — set memory.v2.enabled to true in workspace config."
                )
                setLastResult(pane: pane, result: nil)
                setRawExchange(pane: pane, request: nil, response: nil)
            } catch MemoryRouterPlaygroundError.notAvailable {
                setClientError(
                    pane: pane,
                    message: "Simulate route is not available — the daemon may need to be updated."
                )
                setLastResult(pane: pane, result: nil)
                setRawExchange(pane: pane, request: nil, response: nil)
            } catch let MemoryRouterPlaygroundError.http(statusCode, body) {
                setClientError(
                    pane: pane,
                    message: "HTTP \(statusCode): \(body.isEmpty ? "Failed to run simulation" : body)"
                )
                setLastResult(pane: pane, result: nil)
                setRawExchange(pane: pane, request: nil, response: nil)
            } catch {
                setClientError(pane: pane, message: error.localizedDescription)
                setLastResult(pane: pane, result: nil)
                setRawExchange(pane: pane, request: nil, response: nil)
            }
        }
    }

    private func setIsRunning(pane: PaneId, value: Bool) {
        switch pane {
        case .a: paneA.isRunning = value
        case .b: paneB.isRunning = value
        }
    }

    private func setLastResult(pane: PaneId, result: MemoryRouterSimulateResponse?) {
        switch pane {
        case .a: paneA.lastResult = result
        case .b: paneB.lastResult = result
        }
    }

    private func setValidationError(pane: PaneId, message: String?) {
        switch pane {
        case .a: paneA.validationError = message
        case .b: paneB.validationError = message
        }
    }

    private func setClientError(pane: PaneId, message: String?) {
        switch pane {
        case .a: paneA.clientError = message
        case .b: paneB.clientError = message
        }
    }

    private func setRawExchange(pane: PaneId, request: String?, response: String?) {
        switch pane {
        case .a:
            paneA.rawRequest = request
            paneA.rawResponse = response
        case .b:
            paneB.rawRequest = request
            paneB.rawResponse = response
        }
    }

    private func toggleRawExchange(_ pane: PaneId) {
        switch pane {
        case .a: paneA.showRawExchange.toggle()
        case .b: paneB.showRawExchange.toggle()
        }
    }

    // MARK: - Helpers (shared)

    private func metaRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            Spacer()
            Text(value)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }

    private func formatKnob(effective: Int?, override: MemoryRouterOverride) -> String {
        let effStr: String
        if let v = effective { effStr = "\(v)" } else { effStr = "null" }
        switch override {
        case .inherit: return effStr
        case .value, .disable: return "\(effStr)  (override)"
        }
    }

    private func formatScore(_ value: Double) -> String {
        String(format: "%.3f", value)
    }

    private func parseOverride(field: String, raw: String) throws -> MemoryRouterOverride {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .inherit }
        if trimmed.lowercased() == "null" { return .disable }
        guard let parsed = Int(trimmed), parsed >= 1 else {
            throw MemoryRouterPlaygroundInputError.invalidOverride(field: field, raw: trimmed)
        }
        return .value(parsed)
    }

    private func classifySlugs(
        own: MemoryRouterSimulateResponse,
        other: MemoryRouterSimulateResponse?
    ) -> [String: SlugDiff] {
        guard let other = other else {
            return Dictionary(uniqueKeysWithValues: own.selectedSlugs.map { ($0, .both) })
        }
        let otherSet = Set(other.selectedSlugs)
        return Dictionary(uniqueKeysWithValues: own.selectedSlugs.map {
            ($0, otherSet.contains($0) ? .both : .onlyHere)
        })
    }

    private func countDiff(_ diff: [String: SlugDiff]) -> (shared: Int, unique: Int) {
        var shared = 0
        var unique = 0
        for cls in diff.values {
            if cls == .both { shared += 1 } else { unique += 1 }
        }
        return (shared, unique)
    }

    private struct SourceGroup {
        let source: String
        let slugs: [String]
    }

    private func groupSlugsBySource(
        _ result: MemoryRouterSimulateResponse
    ) -> [SourceGroup] {
        var byKey: [String: [String]] = [:]
        for slug in result.selectedSlugs {
            guard let source = result.sourceBySlug[slug] else { continue }
            byKey[source, default: []].append(slug)
        }
        return byKey.keys
            .sorted(by: { sourceOrder($0) < sourceOrder($1) })
            .map { SourceGroup(source: $0, slugs: byKey[$0] ?? []) }
    }

    private func sourceOrder(_ source: String) -> Int {
        if source == "tier1" { return 0 }
        if source == "tier2" { return 1 }
        if source.hasPrefix("tier3:"),
           let idx = Int(source.dropFirst("tier3:".count)) {
            return 2 + idx
        }
        return Int.max
    }

    private func formatSourceLabel(_ source: String) -> String {
        if source == "tier1" { return "tier 1" }
        if source == "tier2" { return "tier 2" }
        if source.hasPrefix("tier3:") {
            return "tier 3 · b\(source.dropFirst("tier3:".count))"
        }
        return source
    }
}

private enum MemoryRouterPlaygroundInputError: LocalizedError {
    case invalidOverride(field: String, raw: String)

    var errorDescription: String? {
        switch self {
        case .invalidOverride(let field, let raw):
            return "\(field) must be a positive integer or 'null' (got \"\(raw)\")"
        }
    }
}
