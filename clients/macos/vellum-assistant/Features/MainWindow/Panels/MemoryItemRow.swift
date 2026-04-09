import SwiftUI
import VellumAssistantShared

struct MemoryItemRow: View {
    let item: MemoryItemPayload
    let onSelect: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false

    private var memoryKind: MemoryKind? {
        MemoryKind(rawValue: item.kind)
    }

    private var accentColor: Color {
        memoryKind?.color ?? VColor.contentTertiary
    }

    var body: some View {
        VCard(action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                // Kind icon (mirrors emoji slot in skill cards)
                VIconView(.resolve(memoryKind?.icon ?? VIcon.brain.rawValue), size: 28)
                    .foregroundStyle(accentColor)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        VTag(
                            memoryKind?.label ?? item.kind.capitalized,
                            color: accentColor
                        )

                        Spacer()
                    }

                    HStack(alignment: .center, spacing: VSpacing.xs) {
                        Text(item.relativeLastSeen)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)

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

                        Spacer()
                    }
                }

                VButton(
                    label: "Delete",
                    iconOnly: VIcon.trash.rawValue,
                    style: .dangerGhost,
                    size: .compact,
                    action: onDelete
                )
                .opacity(isHovered ? 1 : 0)
                .allowsHitTesting(isHovered)
                .accessibilityHidden(!isHovered)
                .accessibilityLabel("Delete memory")
            }
        }
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
