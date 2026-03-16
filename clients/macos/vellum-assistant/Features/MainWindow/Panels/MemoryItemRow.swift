import SwiftUI
import VellumAssistantShared

struct MemoryItemRow: View {
    let item: MemoryItemPayload
    let onSelect: () -> Void
    let onDelete: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)

                        kindTag
                    }

                    Text(item.statement)
                        .font(VFont.body)
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
            .padding(VSpacing.lg)
            .background(isHovered ? VColor.surfaceActive : Color.clear)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .stroke(VColor.borderDisabled, lineWidth: 2)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Kind Tag

    @ViewBuilder
    private var kindTag: some View {
        let memoryKind = MemoryKind(rawValue: item.kind)
        let color = memoryKind?.color ?? VColor.contentTertiary
        let label = memoryKind?.label ?? item.kind.capitalized

        Text(label)
            .font(VFont.caption)
            .foregroundColor(VColor.contentEmphasized)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .background(color.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            .accessibilityLabel(label)
    }
}
