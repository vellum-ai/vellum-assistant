import SwiftUI
import VellumAssistantShared

struct MemoryItemRow: View {
    let item: MemoryItemPayload
    let onSelect: () -> Void
    let onDelete: () -> Void

    private var memoryKind: MemoryKind? {
        MemoryKind(rawValue: item.kind)
    }

    var body: some View {
        VCard(padding: VSpacing.lg, action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.headline)
                            .foregroundColor(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        VTag(
                            memoryKind?.label ?? item.kind.capitalized,
                            color: memoryKind?.color ?? VColor.contentTertiary
                        )
                    }

                    Text(item.statement)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                        .multilineTextAlignment(.leading)
                }

                Spacer()

                Text(item.relativeLastSeen)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)

                VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .dangerOutline, action: onDelete)
                    .accessibilityLabel("Delete memory")
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
