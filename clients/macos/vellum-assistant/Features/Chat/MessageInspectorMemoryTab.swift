import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - Model

struct MessageInspectorMemoryTabModel: Equatable {
    struct Row: Identifiable, Equatable {
        let label: String
        let value: String

        var id: String { label }
    }

    struct CandidateRow: Identifiable, Equatable {
        let id: String
        let key: String
        let type: String
        let kind: String
        let finalScore: String
        let semanticScore: String
        let recencyScore: String
    }

    let isEnabled: Bool
    let hasData: Bool
    let disabledReason: String?
    let statusRows: [Row]
    let funnelRows: [Row]
    let searchRows: [Row]
    let candidates: [CandidateRow]
    let injectedText: String?
    let degradationReason: String?
    let degradationSemanticUnavailable: Bool
    let degradationFallbackSources: String?

    init(memoryRecall: MemoryRecallData?) {
        guard let recall = memoryRecall else {
            isEnabled = false
            hasData = false
            disabledReason = nil
            statusRows = []
            funnelRows = []
            searchRows = []
            candidates = []
            injectedText = nil
            degradationReason = nil
            degradationSemanticUnavailable = false
            degradationFallbackSources = nil
            return
        }

        hasData = true
        isEnabled = recall.enabled

        if !recall.enabled {
            disabledReason = recall.reason ?? "Memory recall was disabled for this turn."
            statusRows = []
            funnelRows = []
            searchRows = []
            candidates = []
            injectedText = nil
            degradationReason = nil
            degradationSemanticUnavailable = false
            degradationFallbackSources = nil
            return
        }

        disabledReason = nil

        statusRows = [
            .init(label: "Status", value: recall.degraded ? "Degraded" : "Active"),
            .init(label: "Provider", value: Self.displayText(recall.provider)),
            .init(label: "Model", value: Self.displayText(recall.model)),
            .init(label: "Total latency", value: "\(recall.latencyMs) ms"),
        ]

        funnelRows = [
            .init(label: "Semantic hits", value: Self.formatCount(recall.semanticHits)),
            .init(label: "After merge", value: Self.formatCount(recall.mergedCount)),
            .init(label: "Tier 1", value: Self.formatCount(recall.tier1Count)),
            .init(label: "Tier 2", value: Self.formatCount(recall.tier2Count)),
            .init(label: "Selected", value: Self.formatCount(recall.selectedCount)),
            .init(label: "Injected tokens", value: Self.formatCount(recall.injectedTokens)),
        ]

        searchRows = [
            .init(label: "Hybrid search", value: "\(recall.hybridSearchLatencyMs) ms"),
            .init(label: "Sparse vectors", value: recall.sparseVectorUsed ? "Used" : "Dense only"),
        ]

        candidates = recall.topCandidates
            .sorted { $0.finalScore > $1.finalScore }
            .enumerated()
            .map { index, candidate in
                CandidateRow(
                    id: "\(index)-\(candidate.key)",
                    key: candidate.key,
                    type: candidate.type,
                    kind: candidate.kind,
                    finalScore: Self.formatScore(candidate.finalScore),
                    semanticScore: Self.formatScore(candidate.semantic),
                    recencyScore: Self.formatScore(candidate.recency)
                )
            }

        injectedText = recall.injectedText

        if let degradation = recall.degradation {
            degradationReason = degradation.reason
            degradationSemanticUnavailable = degradation.semanticUnavailable
            degradationFallbackSources = degradation.fallbackSources.isEmpty
                ? nil
                : degradation.fallbackSources.joined(separator: ", ")
        } else {
            degradationReason = nil
            degradationSemanticUnavailable = false
            degradationFallbackSources = nil
        }
    }

    private static func displayText(_ value: String?) -> String {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return "Unavailable"
        }
        return value
    }

    private static func formatCount(_ value: Int) -> String {
        numberFormatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    private static func formatScore(_ value: Double) -> String {
        String(format: "%.3f", value)
    }

    private static let numberFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()
}

// MARK: - View

struct MessageInspectorMemoryTab: View {
    let memoryRecall: MemoryRecallData?

    private var model: MessageInspectorMemoryTabModel {
        MessageInspectorMemoryTabModel(memoryRecall: memoryRecall)
    }

    var body: some View {
        Group {
            if !model.hasData {
                noDataState
            } else if !model.isEnabled {
                disabledState
            } else {
                enabledContent
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    // MARK: - Enabled content

    private var enabledContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                scopeBanner
                statusCard
                funnelCard
                searchDetailsCard

                if !model.candidates.isEmpty {
                    candidatesCard
                }

                if model.injectedText != nil {
                    injectedTextCard
                }

                if model.degradationReason != nil {
                    degradationCard
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    // MARK: - Scope banner

    private var scopeBanner: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Turn-level recall")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)

            Text("Memory recall runs once per turn. This data applies to all LLM calls for this message.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
    }

    // MARK: - Status card

    private var statusCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(title: "Status", subtitle: "Provider, model, and latency for this recall.")

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(model.statusRows) { row in
                        metadataRow(row)
                    }
                }
            }
        }
    }

    // MARK: - Funnel card

    private var funnelCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(title: "Retrieval funnel", subtitle: "How memories were filtered from semantic search to injection.")

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(model.funnelRows) { row in
                        metadataRow(row)
                    }
                }
            }
        }
    }

    // MARK: - Search details card

    private var searchDetailsCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(title: "Search details", subtitle: nil)

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(model.searchRows) { row in
                        metadataRow(row)
                    }
                }
            }
        }
    }

    // MARK: - Candidates card

    private var candidatesCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(
                    title: "Top candidates",
                    subtitle: "\(model.candidates.count) candidate(s) ranked by final score."
                )

                LazyVStack(alignment: .leading, spacing: VSpacing.sm) {
                    ForEach(model.candidates) { candidate in
                        candidateRow(candidate)
                    }
                }
            }
        }
    }

    private func candidateRow(_ candidate: MessageInspectorMemoryTabModel.CandidateRow) -> some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(candidate.key)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)

                HStack(spacing: VSpacing.xs) {
                    chip(candidate.type)
                    chip(candidate.kind)
                }
            }

            Spacer(minLength: VSpacing.sm)

            VStack(alignment: .trailing, spacing: VSpacing.xxs) {
                Text(candidate.finalScore)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                HStack(spacing: VSpacing.xs) {
                    Text("sem \(candidate.semanticScore)")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)

                    Text("rec \(candidate.recencyScore)")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, VSpacing.xxs)
            .background(VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    // MARK: - Injected text card

    private var injectedTextCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
                    cardHeader(title: "Injected memory context", subtitle: nil)

                    Spacer(minLength: VSpacing.md)

                    VCopyButton(
                        text: model.injectedText ?? "",
                        size: .compact,
                        accessibilityHint: "Copy injected memory context"
                    )
                }

                HighlightedTextView(
                    text: .constant(model.injectedText ?? ""),
                    language: .plain,
                    isEditable: false,
                    isActivelyEditing: .constant(false)
                )
                .frame(maxWidth: .infinity)
                .frame(minHeight: 120, maxHeight: 400)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
        }
    }

    // MARK: - Degradation card

    private var degradationCard: some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(title: "Degradation", subtitle: nil)

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    metadataRow(.init(label: "Reason", value: model.degradationReason ?? "Unknown"))

                    metadataRow(.init(
                        label: "Semantic unavailable",
                        value: model.degradationSemanticUnavailable ? "Yes" : "No"
                    ))

                    if let sources = model.degradationFallbackSources {
                        metadataRow(.init(label: "Fallback sources", value: sources))
                    }
                }
            }
        }
    }

    // MARK: - Disabled state

    private var disabledState: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        cardHeader(
                            title: "Memory disabled",
                            subtitle: nil
                        )

                        Text(model.disabledReason ?? "Memory recall was disabled for this turn.")
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    // MARK: - No data state

    private var noDataState: some View {
        VEmptyState(
            title: "No memory data",
            subtitle: "Memory recall information is not available for this message.",
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

    private func metadataRow(_ row: MessageInspectorMemoryTabModel.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VSpacing.md) {
            Text(row.label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer(minLength: VSpacing.sm)

            Text(row.value)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}
