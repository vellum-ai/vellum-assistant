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
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    Text(item.subject)
                        .font(VFont.headline)
                        .foregroundStyle(VColor.contentEmphasized)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    VTag(
                        memoryKind?.label ?? item.kind.capitalized,
                        color: memoryKind?.color ?? VColor.contentTertiary
                    )

                    Spacer()

                    VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .dangerGhost, size: .compact, action: onDelete)
                        .accessibilityLabel("Delete memory")
                }

                Text(item.relativeLastSeen)
                    .font(VFont.caption)
                    .foregroundStyle(VColor.contentTertiary)

                Text(item.statement)
                    .font(VFont.bodySmall)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .multilineTextAlignment(.leading)
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
