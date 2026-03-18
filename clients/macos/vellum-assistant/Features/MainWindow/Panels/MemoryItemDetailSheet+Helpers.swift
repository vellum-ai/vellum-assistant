import SwiftUI
import VellumAssistantShared

extension MemoryItemDetailSheet {

    var memoryKind: MemoryKind? {
        MemoryKind(rawValue: displayItem.kind)
    }

    var kindBadge: some View {
        VBadge(
            label: memoryKind?.label ?? displayItem.kind.capitalized,
            color: memoryKind?.color ?? VColor.contentTertiary,
            shape: .rounded
        )
    }

    func metadataRow(label: String, value: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentSecondary)
        }
    }

    func formattedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
