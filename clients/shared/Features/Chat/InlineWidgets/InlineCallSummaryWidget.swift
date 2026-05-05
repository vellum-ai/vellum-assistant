import SwiftUI

/// Inline widget showing a completed call summary with expandable event list.
public struct InlineCallSummaryWidget: View {
    public let data: CallSummaryData

    @State private var isExpanded = false

    public init(data: CallSummaryData) {
        self.data = data
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded && !data.events.isEmpty {
                Divider()
                    .padding(.horizontal, VSpacing.md)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(Array(data.events.enumerated()), id: \.offset) { _, event in
                        eventRow(event)
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
            }
        }
    }

    @ViewBuilder
    private var headerRow: some View {
        let row = HStack(spacing: VSpacing.sm) {
            VIconView(.phone, size: 14)
                .foregroundStyle(iconColor)

            Text(data.summaryText)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)

            if let duration = data.formattedDuration {
                Text(duration)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Spacer()

            if !data.events.isEmpty {
                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 12)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)

        if data.events.isEmpty {
            row
        } else {
            Button {
                withAnimation(VAnimation.fast) {
                    isExpanded.toggle()
                }
            } label: {
                row
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func eventRow(_ event: CallSummaryEvent) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
            Text(event.displayName)
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentDefault)

            Spacer()

            Text(event.date.formatted(date: .omitted, time: .shortened))
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.vertical, VSpacing.xxs)
    }

    private var iconColor: Color {
        switch data.status {
        case "completed": return VColor.systemPositiveStrong
        case "no_answer": return VColor.contentSecondary
        default: return VColor.systemNegativeStrong
        }
    }
}
