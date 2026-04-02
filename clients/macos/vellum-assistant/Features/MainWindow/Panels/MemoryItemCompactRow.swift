import SwiftUI
import VellumAssistantShared

/// Dense single-line memory row for compact browse mode.
struct MemoryItemCompactRow: View {
    let item: MemoryItemPayload
    let isSelected: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false

    private var memoryKind: MemoryKind? {
        MemoryKind(rawValue: item.kind)
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: VSpacing.sm) {
                Circle()
                    .fill(memoryKind?.color ?? VColor.contentTertiary)
                    .frame(width: 8, height: 8)

                Text(item.subject)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()

                Text(item.relativeLastSeen)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isSelected
                        ? (memoryKind?.backgroundTint ?? VColor.surfaceActive)
                        : (isHovered ? VColor.surfaceBase : Color.clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive) {
                onDelete()
            }
        }
    }
}
