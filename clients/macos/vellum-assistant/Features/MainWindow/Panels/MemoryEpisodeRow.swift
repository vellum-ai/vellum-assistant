import SwiftUI
import VellumAssistantShared

struct MemoryEpisodeRow: View {
    let episode: MemoryEpisodePayload
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            titleText
            summaryText
            footerRow
        }
        .padding(VSpacing.lg)
        .background(isHovered ? VColor.surfaceActive : Color.clear)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Title

    @ViewBuilder
    private var titleText: some View {
        Text(episode.title)
            .font(VFont.bodyBold)
            .foregroundColor(VColor.contentDefault)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Summary

    @ViewBuilder
    private var summaryText: some View {
        Text(episode.summary)
            .font(VFont.caption)
            .foregroundColor(VColor.contentSecondary)
            .lineLimit(3)
            .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footerRow: some View {
        HStack(spacing: VSpacing.sm) {
            timeSpanLabel

            if let title = episode.conversationTitle, !title.isEmpty {
                Text(title)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(1)
            }

            Spacer()

            if let source = episode.source, !source.isEmpty {
                VBadge(label: source, tone: .neutral, emphasis: .subtle, shape: .pill)
            }
        }
    }

    // MARK: - Time Span

    private var timeSpanLabel: some View {
        HStack(spacing: VSpacing.xxs) {
            VIconView(.calendar, size: 11)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)
            Text(formattedTimeSpan)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    private var formattedTimeSpan: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        let start = formatter.string(from: episode.startDate)
        let end = formatter.string(from: episode.endDate)
        if start == end { return start }
        return "\(start) \u{2192} \(end)"
    }
}
