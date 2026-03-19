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

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                // Kind icon
                kindIcon

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)

                        kindTag

                        if let scopeLabel = item.scopeLabel {
                            VBadge(label: scopeLabel, icon: .lock, tone: .neutral, emphasis: .subtle, shape: .pill)
                        }
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Kind Icon

    @ViewBuilder
    private var kindIcon: some View {
        if let kind = memoryKind, let icon = VIcon(rawValue: kind.icon) {
            VIconView(icon, size: 20)
                .foregroundColor(kind.color)
                .frame(width: 40, height: 40)
        } else {
            VIconView(.brain, size: 20)
                .foregroundColor(VColor.contentTertiary)
                .frame(width: 40, height: 40)
        }
    }

    // MARK: - Kind Tag

    private var kindTag: some View {
        VBadge(
            label: memoryKind?.label ?? item.kind.capitalized,
            color: memoryKind?.color ?? VColor.contentTertiary,
            shape: .pill
        )
    }
}
