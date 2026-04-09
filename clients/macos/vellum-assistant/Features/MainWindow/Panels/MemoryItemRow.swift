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
        VCard(action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        Spacer()
                    }

                    HStack(alignment: .center, spacing: VSpacing.xs) {
                        VTag(
                            memoryKind?.label ?? item.kind.capitalized,
                            color: accentColor
                        )

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
                    leftIcon: VIcon.trash.rawValue,
                    style: .dangerOutline,
                    action: onDelete
                )
                .accessibilityLabel("Delete memory")
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
