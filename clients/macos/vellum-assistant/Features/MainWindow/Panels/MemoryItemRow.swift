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
        VCard(action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        VTag(
                            memoryKind?.label ?? item.kind.capitalized,
                            color: memoryKind?.color ?? VColor.contentTertiary
                        )
                    }

                    Text(item.statement)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer()

                VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .dangerGhost, size: .compact, action: onDelete)
                    .accessibilityLabel("Delete memory")
            }
        }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
