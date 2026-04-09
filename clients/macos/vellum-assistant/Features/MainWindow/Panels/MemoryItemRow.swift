import SwiftUI
import VellumAssistantShared

struct MemoryItemRow: View {
    let item: MemoryItemPayload
    let onSelect: () -> Void
    let onDelete: () -> Void

    private var memoryKind: MemoryKind? {
        MemoryKind(rawValue: item.kind)
    }

    private var accentColor: Color {
        memoryKind?.color ?? VColor.contentTertiary
    }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            // Accent bar
            RoundedRectangle(cornerRadius: 2)
                .fill(accentColor)
                .frame(width: 4)

            // Content area
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                // Subject
                Text(item.subject)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                    .lineLimit(1)
                    .truncationMode(.tail)

                // Metadata row: kind tag + confidence + source + timestamp
                HStack(alignment: .center, spacing: VSpacing.xs) {
                    VTag(
                        memoryKind?.label ?? item.kind.capitalized,
                        color: accentColor
                    )

                    if let confidence = item.confidence, confidence > 0 {
                        Text("\u{00B7}")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Text("\(Int(confidence * 100))% confident")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }

                    if let sourceLabel = item.sourceLabel {
                        Text("\u{00B7}")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Text(sourceLabel)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }

                    Text("\u{00B7}")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Text(item.relativeLastSeen)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    Spacer()
                }
            }
            .padding(.leading, VSpacing.md)

            Spacer()

            VButton(label: "Remove", leftIcon: VIcon.trash.rawValue, style: .dangerOutline, action: onDelete)
                .padding(.trailing, VSpacing.md)
        }
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(memoryKind?.backgroundTint ?? Color.clear)
        )
        .contentShape(Rectangle())
        .onTapGesture { onSelect() }
        .pointerCursor()
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
