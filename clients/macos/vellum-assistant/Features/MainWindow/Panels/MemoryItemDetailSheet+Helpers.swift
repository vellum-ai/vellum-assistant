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
}
