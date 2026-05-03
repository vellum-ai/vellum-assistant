import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - Model

struct MessageInspectorMemoryV2TabModel: Equatable {
    struct ConfigVM: Equatable {
        let d: String
        let cUser: String
        let cAssistant: String
        let cNow: String
        let k: String
        let hops: String
        let topK: String
        let topKSkills: String
        let epsilon: String
    }

    struct ConceptRowVM: Identifiable, Equatable {
        let id: String
        let slug: String
        let status: String
        let source: String
        let finalActivation: Double
        let finalActivationLabel: String
        let ownActivationLabel: String
        let priorActivationLabel: String
        let spreadContributionLabel: String
        let simBreakdownRows: [LabeledValue]
    }

    struct SkillRowVM: Identifiable, Equatable {
        let id: String
        let status: String
        let activation: Double
        let activationLabel: String
        let simBreakdownRows: [LabeledValue]
    }

    struct LabeledValue: Equatable {
        let label: String
        let value: String
    }

    let mode: String
    let turn: Int
    let conceptRows: [ConceptRowVM]
    let skillRows: [SkillRowVM]
    let inContextCount: Int
    let injectedCount: Int
    let notInjectedCount: Int
    let config: ConfigVM

    static func from(activation: MemoryV2ActivationData) -> MessageInspectorMemoryV2TabModel {
        let conceptRows = activation.concepts
            .sorted { $0.finalActivation > $1.finalActivation }
            .map { concept in
                ConceptRowVM(
                    id: concept.slug,
                    slug: concept.slug,
                    status: concept.status,
                    source: concept.source,
                    finalActivation: concept.finalActivation,
                    finalActivationLabel: formatActivation(concept.finalActivation),
                    ownActivationLabel: formatActivation(concept.ownActivation),
                    priorActivationLabel: formatActivation(concept.priorActivation),
                    spreadContributionLabel: formatActivation(concept.spreadContribution),
                    simBreakdownRows: simBreakdownRows(
                        simUser: concept.simUser,
                        simAssistant: concept.simAssistant,
                        simNow: concept.simNow,
                        config: activation.config
                    )
                )
            }

        let skillRows = activation.skills
            .sorted { $0.activation > $1.activation }
            .map { skill in
                SkillRowVM(
                    id: skill.id,
                    status: skill.status,
                    activation: skill.activation,
                    activationLabel: formatActivation(skill.activation),
                    simBreakdownRows: simBreakdownRows(
                        simUser: skill.simUser,
                        simAssistant: skill.simAssistant,
                        simNow: skill.simNow,
                        config: activation.config
                    )
                )
            }

        // Concept-only partition: skills lack `in_context`, so summing them in would
        // make the three chips asymmetric. Skills are surfaced in their own card.
        let inContext = conceptRows.filter { $0.status == "in_context" }.count
        let injected = conceptRows.filter { $0.status == "injected" }.count
        let notInjected = conceptRows.filter { $0.status == "not_injected" }.count

        let config = ConfigVM(
            d: formatActivation(activation.config.d),
            cUser: formatActivation(activation.config.cUser),
            cAssistant: formatActivation(activation.config.cAssistant),
            cNow: formatActivation(activation.config.cNow),
            k: formatActivation(activation.config.k),
            hops: "\(activation.config.hops)",
            topK: "\(activation.config.topK)",
            topKSkills: "\(activation.config.topKSkills)",
            epsilon: formatActivation(activation.config.epsilon)
        )

        return MessageInspectorMemoryV2TabModel(
            mode: activation.mode,
            turn: activation.turn,
            conceptRows: conceptRows,
            skillRows: skillRows,
            inContextCount: inContext,
            injectedCount: injected,
            notInjectedCount: notInjected,
            config: config
        )
    }

    static func formatActivation(_ value: Double) -> String {
        String(format: "%.3f", value)
    }

    static func formatScaled(_ value: Double, scale: Double) -> String {
        String(format: "%.3f", value * scale)
    }

    private static func simBreakdownRows(
        simUser: Double,
        simAssistant: Double,
        simNow: Double,
        config: MemoryV2Config
    ) -> [LabeledValue] {
        [
            LabeledValue(
                label: "c_user · sim_u",
                value: "\(formatScaled(simUser, scale: config.cUser))  (raw \(formatActivation(simUser)))"
            ),
            LabeledValue(
                label: "c_assistant · sim_a",
                value: "\(formatScaled(simAssistant, scale: config.cAssistant))  (raw \(formatActivation(simAssistant)))"
            ),
            LabeledValue(
                label: "c_now · sim_n",
                value: "\(formatScaled(simNow, scale: config.cNow))  (raw \(formatActivation(simNow)))"
            ),
        ]
    }
}

// MARK: - View

struct MessageInspectorMemoryV2Tab: View {
    private let model: MessageInspectorMemoryV2TabModel?

    init(activation: MemoryV2ActivationData?) {
        self.model = activation.map(MessageInspectorMemoryV2TabModel.from(activation:))
    }

    var body: some View {
        Group {
            if let model {
                content(model: model)
            } else {
                noDataState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    @ViewBuilder
    private func content(model: MessageInspectorMemoryV2TabModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                statusBanner(model: model)
                countsRow(model: model)
                configCard(config: model.config)
                conceptsCard(rows: model.conceptRows)
                skillsCard(rows: model.skillRows)
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    // MARK: - Status banner

    private func statusBanner(model: MessageInspectorMemoryV2TabModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Memory v2 — turn \(model.turn) (\(model.mode))")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Text("Spreading-activation memory pass that ranks concepts and skills for this turn.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Counts pill row

    private func countsRow(model: MessageInspectorMemoryV2TabModel) -> some View {
        HStack(spacing: VSpacing.sm) {
            countChip(
                label: "In context: \(model.inContextCount)",
                tint: statusColor("in_context")
            )
            countChip(
                label: "Injected: \(model.injectedCount)",
                tint: statusColor("injected")
            )
            countChip(
                label: "Not injected: \(model.notInjectedCount)",
                tint: statusColor("not_injected")
            )
            Spacer(minLength: 0)
        }
    }

    private func countChip(label: String, tint: Color) -> some View {
        HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)

            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
    }

    // MARK: - Config card

    private func configCard(config: MessageInspectorMemoryV2TabModel.ConfigVM) -> some View {
        VCard {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    metadataRow(label: "d (decay)", value: config.d)
                    metadataRow(label: "c_user", value: config.cUser)
                    metadataRow(label: "c_assistant", value: config.cAssistant)
                    metadataRow(label: "c_now", value: config.cNow)
                    metadataRow(label: "k (sharpening)", value: config.k)
                    metadataRow(label: "hops", value: config.hops)
                    metadataRow(label: "top_k", value: config.topK)
                    metadataRow(label: "top_k_skills", value: config.topKSkills)
                    metadataRow(label: "epsilon", value: config.epsilon)
                }
                .padding(.top, VSpacing.sm)
            } label: {
                cardHeader(title: "Config", subtitle: "Activation weights and selection thresholds.")
            }
            .disclosureGroupStyle(.automatic)
        }
    }

    // MARK: - Concept activations

    private func conceptsCard(rows: [MessageInspectorMemoryV2TabModel.ConceptRowVM]) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(
                    title: "Concept activations (\(rows.count))",
                    subtitle: "Sorted by final activation. Expand a row for the activation breakdown."
                )

                if rows.isEmpty {
                    Text("No concepts ranked.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(rows) { row in
                            ConceptRowView(row: row)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Skills

    private func skillsCard(
        rows: [MessageInspectorMemoryV2TabModel.SkillRowVM]
    ) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(
                    title: "Skills (\(rows.count))",
                    subtitle: "Sorted by activation. Green-dotted rows are injected this turn; the rest are scored but not picked."
                )

                if rows.isEmpty {
                    Text("No skills ranked.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(rows) { row in
                            SkillRowView(row: row)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Empty state

    private var noDataState: some View {
        VEmptyState(
            title: "No memory v2 data",
            subtitle: "Memory v2 didn't run for this turn.",
            icon: VIcon.brain.rawValue
        )
        .frame(minHeight: 280)
    }

    // MARK: - Shared helpers

    private func cardHeader(title: String, subtitle: String?) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(title)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VSpacing.md) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer(minLength: VSpacing.sm)

            Text(value)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Status color helper

private func statusColor(_ status: String) -> Color {
    switch status {
    case "in_context":
        return VColor.contentSecondary
    case "injected":
        return VColor.systemPositiveStrong
    case "not_injected":
        return VColor.contentDisabled
    default:
        return VColor.contentTertiary
    }
}

private func statusLabel(_ status: String) -> String {
    switch status {
    case "in_context":
        return "In context"
    case "injected":
        return "Injected"
    case "not_injected":
        return "Not injected"
    default:
        return status
    }
}

private func activationBreakdownRow(label: String, value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: VSpacing.md) {
        Text(label)
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentSecondary)

        Spacer(minLength: VSpacing.sm)

        Text(value)
            .font(VFont.bodyMediumDefault)
            .foregroundStyle(VColor.contentDefault)
            .monospacedDigit()
            .textSelection(.enabled)
    }
}

// MARK: - Activation row (shared between concepts and skills)

private struct ActivationRowConfig {
    let id: String
    let activation: Double
    let activationLabel: String
    let statusColor: Color
    let sourceBadge: String?
    let breakdownRows: [MessageInspectorMemoryV2TabModel.LabeledValue]
    let statusLabel: String
}

private struct ActivationRowView: View {
    let config: ActivationRowConfig
    /// Optional trailing content rendered inside the expanded disclosure
    /// after the breakdown rows. Concept rows pass a `ConceptPageContentView`
    /// here so the raw page markdown shows up alongside the activation
    /// breakdown; skill rows pass nil.
    let expandedTrailing: AnyView?
    @State private var isExpanded = false

    init(config: ActivationRowConfig, expandedTrailing: AnyView? = nil) {
        self.config = config
        self.expandedTrailing = expandedTrailing
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(config.breakdownRows, id: \.label) { row in
                    activationBreakdownRow(label: row.label, value: row.value)
                }
                activationBreakdownRow(label: "status", value: config.statusLabel)
                if let expandedTrailing {
                    expandedTrailing
                }
            }
            .padding(.top, VSpacing.xs)
            .padding(.leading, VSpacing.md)
        } label: {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                Circle()
                    .fill(config.statusColor)
                    .frame(width: 8, height: 8)

                Text(config.id)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                if let sourceBadge = config.sourceBadge {
                    Text(sourceBadge)
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentSecondary)
                        .padding(.horizontal, VSpacing.xs)
                        .padding(.vertical, VSpacing.xxs)
                        .background(VColor.surfaceBase)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }

                Spacer(minLength: VSpacing.sm)

                ActivationBar(value: config.activation)
                    .frame(width: 60, height: 6)

                Text(config.activationLabel)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .monospacedDigit()
            }
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }
}

// MARK: - Concept row

private struct ConceptRowView: View {
    let row: MessageInspectorMemoryV2TabModel.ConceptRowVM

    var body: some View {
        let isCustomSource = row.source != "ann_top50"
        var breakdownRows: [MessageInspectorMemoryV2TabModel.LabeledValue] = [
            .init(label: "A_o (own)", value: row.ownActivationLabel),
            .init(label: "spread Δ", value: row.spreadContributionLabel),
            .init(label: "prior · d", value: row.priorActivationLabel),
        ]
        breakdownRows.append(contentsOf: row.simBreakdownRows)
        if isCustomSource {
            breakdownRows.append(.init(label: "source", value: row.source))
        }

        return ActivationRowView(
            config: ActivationRowConfig(
                id: row.slug,
                activation: row.finalActivation,
                activationLabel: row.finalActivationLabel,
                statusColor: statusColor(row.status),
                sourceBadge: isCustomSource ? row.source : nil,
                breakdownRows: breakdownRows,
                statusLabel: statusLabel(row.status)
            ),
            expandedTrailing: AnyView(ConceptPageContentView(slug: row.slug))
        )
    }
}

// MARK: - Concept page content (lazy-loaded on row expand)

private struct ConceptPageContentView: View {
    let slug: String
    @State private var state: LoadState = .idle

    enum LoadState: Equatable {
        case idle
        case loading
        case missing
        case loaded(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("page content")
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.top, VSpacing.sm)

            content
        }
        .task(id: slug) {
            // SwiftUI fires `.task` when this view first renders inside
            // the disclosed disclosure body — i.e., on first expand. The
            // load runs once per slug; cached `state` is reused across
            // subsequent collapses+re-expands of the same row.
            guard state == .idle else { return }
            state = .loading
            let client = LLMContextClient()
            if let rendered = await client.fetchConceptPage(slug: slug) {
                state = .loaded(rendered)
            } else {
                state = .missing
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle, .loading:
            HStack(spacing: VSpacing.xs) {
                ProgressView().controlSize(.small)
                Text("Loading…")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
            }
        case .missing:
            Text("Page not found on disk — slug may reference a stale Qdrant entry.")
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
        case .loaded(let text):
            HStack(spacing: 0) {
                Text(text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                Spacer(minLength: 0)
            }
            .padding(VSpacing.sm)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
    }
}

// MARK: - Skill row

private struct SkillRowView: View {
    let row: MessageInspectorMemoryV2TabModel.SkillRowVM

    var body: some View {
        ActivationRowView(config: ActivationRowConfig(
            id: row.id,
            activation: row.activation,
            activationLabel: row.activationLabel,
            statusColor: statusColor(row.status),
            sourceBadge: nil,
            breakdownRows: row.simBreakdownRows,
            statusLabel: statusLabel(row.status)
        ))
    }
}

// MARK: - Activation bar

private struct ActivationBar: View {
    let value: Double

    var body: some View {
        GeometryReader { geometry in
            let clamped = max(0.0, min(value, 1.0))
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: VRadius.pill)
                    .fill(VColor.surfaceActive)

                RoundedRectangle(cornerRadius: VRadius.pill)
                    .fill(VColor.primaryBase)
                    .frame(width: geometry.size.width * CGFloat(clamped))
            }
        }
    }
}

// MARK: - Preview

#Preview("Memory v2 inspector tab") {
    let fixture = MemoryV2ActivationData(
        turn: 7,
        mode: "per-turn",
        concepts: [
            MemoryV2ConceptRow(
                slug: "user-prefers-dark-mode",
                finalActivation: 0.842,
                ownActivation: 0.512,
                priorActivation: 0.220,
                simUser: 0.610,
                simAssistant: 0.305,
                simNow: 0.120,
                spreadContribution: 0.110,
                source: "both",
                status: "injected"
            ),
            MemoryV2ConceptRow(
                slug: "project-onboarding-notes",
                finalActivation: 0.610,
                ownActivation: 0.430,
                priorActivation: 0.150,
                simUser: 0.420,
                simAssistant: 0.260,
                simNow: 0.080,
                spreadContribution: 0.060,
                source: "ann_top50",
                status: "in_context"
            ),
            MemoryV2ConceptRow(
                slug: "feedback-prefer-tdd",
                finalActivation: 0.180,
                ownActivation: 0.140,
                priorActivation: 0.030,
                simUser: 0.190,
                simAssistant: 0.100,
                simNow: 0.020,
                spreadContribution: 0.010,
                source: "prior_state",
                status: "not_injected"
            ),
        ],
        skills: [
            MemoryV2SkillRow(
                id: "meeting-bot",
                activation: 0.720,
                simUser: 0.510,
                simAssistant: 0.420,
                simNow: 0.090,
                status: "injected"
            ),
            MemoryV2SkillRow(
                id: "calendar-search",
                activation: 0.140,
                simUser: 0.180,
                simAssistant: 0.110,
                simNow: 0.020,
                status: "not_injected"
            ),
        ],
        config: MemoryV2Config(
            d: 0.85,
            cUser: 0.6,
            cAssistant: 0.3,
            cNow: 0.1,
            k: 4.0,
            hops: 2,
            topK: 12,
            topKSkills: 4,
            epsilon: 0.05
        )
    )

    MessageInspectorMemoryV2Tab(activation: fixture)
        .frame(width: 600, height: 800)
}

#Preview("Memory v2 inspector tab — empty") {
    MessageInspectorMemoryV2Tab(activation: nil)
        .frame(width: 600, height: 600)
}
