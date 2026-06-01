import Foundation
import SwiftUI
import VellumAssistantShared

// MARK: - Model

struct MessageInspectorMemoryV3TabModel: Equatable {
    struct SelectionRowVM: Identifiable, Equatable {
        let id: String
        let slug: String
        let sourceLabel: String
        let pinned: Bool
    }

    /// True when `memory-v3-live` is on — the block was actually injected.
    /// When false (shadow), the block is what v3 *would* have injected.
    let isLive: Bool
    let modeLabel: String
    let turn: Int
    let selectedCount: Int
    let coreCount: Int
    let carryForwardCount: Int
    let pinnedCount: Int
    let rows: [SelectionRowVM]
    let injectedText: String

    static func from(selection: MemoryV3SelectionData) -> MessageInspectorMemoryV3TabModel {
        let rows = selection.selections.map { sel in
            SelectionRowVM(
                id: sel.slug,
                slug: sel.slug,
                sourceLabel: sourceLabel(sel.source),
                pinned: sel.pinned
            )
        }
        let core = selection.selections.filter { $0.source.hasPrefix("core") }.count
        let carry = selection.selections.filter { $0.source == "carry-forward" }.count
        let pinned = selection.selections.filter { $0.pinned }.count
        let modeLabel = selection.live
            ? "Live — injected"
            : (selection.shadow ? "Shadow — not injected" : "Off")

        return MessageInspectorMemoryV3TabModel(
            isLive: selection.live,
            modeLabel: modeLabel,
            turn: selection.turn,
            selectedCount: selection.selections.count,
            coreCount: core,
            carryForwardCount: carry,
            pinnedCount: pinned,
            rows: rows,
            injectedText: selection.injectedText
        )
    }

    /// Display label for a v3 selection lane (`source`).
    static func sourceLabel(_ source: String) -> String {
        switch source {
        case "l1+l2": return "L1+L2"
        case "core+l2": return "core"
        case "carry-forward": return "carried"
        case "needle": return "needle"
        default: return source
        }
    }
}

// MARK: - View

struct MessageInspectorMemoryV3Tab: View {
    private let model: MessageInspectorMemoryV3TabModel?

    init(selection: MemoryV3SelectionData?) {
        self.model = selection.map(MessageInspectorMemoryV3TabModel.from(selection:))
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
    private func content(model: MessageInspectorMemoryV3TabModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                statusBanner(model: model)
                countsRow(model: model)
                selectionsCard(rows: model.rows)
                if !model.injectedText.isEmpty {
                    injectedTextCard(model: model)
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    // MARK: - Status banner

    private func statusBanner(model: MessageInspectorMemoryV3TabModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(model.isLive
                     ? "Memory V3 — live injection"
                     : "Memory V3 — shadow (observation only)")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Text(model.isLive
                     ? "v3 is the live memory source this turn — the block below was injected into context (v2 suppressed)."
                     : "v3 ran in shadow this turn. The block below is what it would have injected; the live memory came from v2.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Counts pill row

    private func countsRow(model: MessageInspectorMemoryV3TabModel) -> some View {
        HStack(spacing: VSpacing.sm) {
            countChip(label: "Turn \(model.turn)")
            countChip(label: "Selected: \(model.selectedCount)")
            countChip(label: "Core: \(model.coreCount)")
            countChip(label: "Carried: \(model.carryForwardCount)")
            countChip(label: "Pinned: \(model.pinnedCount)")
            Spacer(minLength: 0)
        }
    }

    private func countChip(label: String) -> some View {
        Text(label)
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
    }

    // MARK: - Selected pages

    private func selectionsCard(rows: [MessageInspectorMemoryV3TabModel.SelectionRowVM]) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                cardHeader(
                    title: "Selected pages (\(rows.count))",
                    subtitle: "Pages the v3 working set selected, tagged by the lane that surfaced them."
                )

                if rows.isEmpty {
                    Text("No pages selected.")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                } else {
                    LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(rows) { row in
                            selectionRow(row: row)
                        }
                    }
                }
            }
        }
    }

    private func selectionRow(row: MessageInspectorMemoryV3TabModel.SelectionRowVM) -> some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text(row.slug)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .textSelection(.enabled)

            Spacer(minLength: VSpacing.sm)

            if row.pinned {
                badge("pinned")
            }
            badge(row.sourceLabel)
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, VSpacing.xxs)
            .background(VColor.surfaceOverlay)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    // MARK: - Rendered block

    private func injectedTextCard(model: MessageInspectorMemoryV3TabModel) -> some View {
        VCard {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                cardHeader(
                    title: model.isLive ? "Injected memory context" : "Would-be memory context",
                    subtitle: model.isLive
                        ? nil
                        : "Rendered from the v3 selection — not injected this turn."
                )

                Text(model.injectedText)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceBase)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
        }
    }

    // MARK: - Empty state

    private var noDataState: some View {
        VEmptyState(
            title: "No memory data",
            subtitle: "v3 retrieval didn't run for this turn.",
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
}
