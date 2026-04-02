import SwiftUI
import VellumAssistantShared

extension MemoryItemDetailSheet {

    var memoryKind: MemoryKind? {
        MemoryKind(rawValue: displayItem.kind)
    }

    var kindBadge: some View {
        VTag(
            memoryKind?.label ?? displayItem.kind.capitalized,
            color: memoryKind?.color ?? VColor.contentTertiary
        )
    }

    func metadataRow(label: String, value: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
    }

    func formattedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = ChatTimestampTimeZone.resolve()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// Small horizontal bar showing a 0–1 value. Width is the total track width.
    func metricBar(value: Double, color: Color, width: CGFloat = 60, height: CGFloat = 6) -> some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: height / 2)
                .fill(VColor.surfaceActive)
                .frame(width: width, height: height)
            RoundedRectangle(cornerRadius: height / 2)
                .fill(color)
                .frame(width: value > 0 ? max(height, width * CGFloat(min(value, 1))) : 0, height: height)
        }
    }

    /// Graduated color for a confidence value: green above 0.7, amber 0.3–0.7, red below 0.3.
    func confidenceColor(_ value: Double) -> Color {
        if value >= 0.7 { return VColor.systemPositiveStrong }
        if value >= 0.3 { return VColor.systemMidStrong }
        return VColor.systemNegativeStrong
    }

    /// Inline source type view with icon and label.
    @ViewBuilder
    func sourceTypeIndicator(_ sourceType: String) -> some View {
        switch sourceType {
        case "direct":
            HStack(spacing: VSpacing.xxs) {
                VIconView(.circleCheck, size: 12)
                    .foregroundStyle(VColor.systemPositiveStrong)
                Text("Told directly")
            }
        case "observed":
            HStack(spacing: VSpacing.xxs) {
                VIconView(.eye, size: 12)
                    .foregroundStyle(VColor.contentSecondary)
                Text("Observed")
            }
        default:
            HStack(spacing: VSpacing.xxs) {
                VIconView(.sparkles, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
                Text("Inferred")
            }
        }
    }
}
