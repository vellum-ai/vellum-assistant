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
            HStack(alignment: .top, spacing: VSpacing.lg) {
                // Icon — top-aligned, matching skill card
                kindIcon

                // Text content
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    // Header + timestamp group
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: VSpacing.sm) {
                            Text(item.subject)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                                .lineLimit(1)
                                .truncationMode(.tail)

                            Spacer()

                            kindTag

                            if let scopeLabel = item.scopeLabel {
                                VBadge(label: scopeLabel, icon: .lock, tone: .neutral, emphasis: .subtle, shape: .pill)
                            }

                            VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .dangerGhost, action: onDelete)
                                .accessibilityLabel("Delete memory")
                        }

                        Text(item.relativeLastSeen)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    // Description — fixed 2-line height for uniform cards
                    Text(item.statement)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, minHeight: 28, alignment: .topLeading)
                }
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
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
