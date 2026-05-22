import SwiftUI
import VellumAssistantShared

/// Settings tab for the v4 memory router simulator. Lets a developer
/// preview which concept pages the router would select for a given query
/// under custom `tier1_size`, `tier2_size`, and `batch_size` overrides —
/// without touching the live EMA event log or activation log.
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

    @State private var query: String = ""
    @State private var tier1Raw: String = ""
    @State private var tier2Raw: String = ""
    @State private var batchRaw: String = ""
    @State private var isRunning: Bool = false
    @State private var validationError: String?
    @State private var clientError: String?
    @State private var lastResult: MemoryRouterSimulateResponse?
    @State private var lastQuery: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                header
                formCard
                if let err = validationError ?? clientError {
                    errorBanner(err)
                }
                if let result = lastResult {
                    resultSection(result)
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
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

    // MARK: - Form

    private var formCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Query")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                TextEditor(text: $query)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .frame(minHeight: 80)
                    .background(VColor.surfaceBase)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }

            HStack(alignment: .top, spacing: VSpacing.md) {
                overrideField(label: "tier1_size", value: $tier1Raw)
                overrideField(label: "tier2_size", value: $tier2Raw)
                overrideField(label: "batch_size", value: $batchRaw)
            }

            HStack {
                Spacer()
                VButton(
                    label: isRunning ? "Running…" : "Run simulation",
                    style: .primary,
                    isDisabled: !canRun
                ) {
                    runSimulation()
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func overrideField(label: String, value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            TextField("inherit", text: value)
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

    // MARK: - Result Section

    @ViewBuilder
    private func resultSection(_ result: MemoryRouterSimulateResponse) -> some View {
        summaryCard(result)
        configCard(result)
        if let reason = result.failureReason {
            errorBanner("Router failure: \(reason)")
        }
        let groups = groupSlugsBySource(result)
        if groups.isEmpty {
            emptyResultCard
        } else {
            ForEach(groups, id: \.source) { group in
                tierCard(group: group, scores: result.scores)
            }
        }
    }

    private func summaryCard(_ result: MemoryRouterSimulateResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Summary")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            metaRow(label: "Query", value: lastQuery)
            metaRow(
                label: "Total candidate pages",
                value: "\(result.totalCandidatePages)"
            )
            metaRow(
                label: "Selected",
                value: "\(result.selectedSlugs.count) / \(result.effectiveConfig.maxPageIds)"
            )
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
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    private func tierCard(
        group: SourceGroup,
        scores: [String: Double]
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
                    HStack {
                        Text(slug)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                            .textSelection(.enabled)
                        Spacer()
                        if group.source == "tier2" {
                            Text("EMA \(formatScore(scores[slug] ?? 0))")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
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

    // MARK: - Helpers

    private var canRun: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isRunning
    }

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

    private func runSimulation() {
        validationError = nil
        clientError = nil

        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else { return }

        let tier1Override: MemoryRouterOverride
        let tier2Override: MemoryRouterOverride
        let batchOverride: MemoryRouterOverride
        do {
            tier1Override = try parseOverride(field: "tier1_size", raw: tier1Raw)
            tier2Override = try parseOverride(field: "tier2_size", raw: tier2Raw)
            batchOverride = try parseOverride(field: "batch_size", raw: batchRaw)
        } catch {
            validationError = error.localizedDescription
            return
        }

        let input = MemoryRouterSimulateInput(
            query: trimmedQuery,
            tier1Size: tier1Override,
            tier2Size: tier2Override,
            batchSize: batchOverride
        )

        isRunning = true
        lastQuery = trimmedQuery
        Task {
            defer { isRunning = false }
            do {
                let result = try await client.simulate(input: input)
                lastResult = result
                clientError = nil
            } catch MemoryRouterPlaygroundError.memoryV2Disabled {
                clientError = "Memory v2 is not enabled on this assistant — set memory.v2.enabled to true in workspace config."
                lastResult = nil
            } catch MemoryRouterPlaygroundError.notAvailable {
                clientError = "Simulate route is not available — the daemon may need to be updated."
                lastResult = nil
            } catch let MemoryRouterPlaygroundError.http(statusCode, body) {
                clientError = "HTTP \(statusCode): \(body.isEmpty ? "Failed to run simulation" : body)"
                lastResult = nil
            } catch {
                clientError = error.localizedDescription
                lastResult = nil
            }
        }
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
