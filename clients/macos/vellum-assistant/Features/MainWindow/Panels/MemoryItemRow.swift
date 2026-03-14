import SwiftUI
import VellumAssistantShared

struct MemoryItemRow: View {
    let item: MemoryItemPayload
    let onSelect: () -> Void
    let onDelete: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                HStack(spacing: VSpacing.sm) {
                    Text(item.subject)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)

                    kindBadge

                    Spacer()

                    if item.isUserConfirmed {
                        VIconView(.circleCheck, size: 12)
                            .foregroundColor(VColor.systemPositiveStrong)
                            .accessibilityLabel("User confirmed")
                    }

                    Text(item.relativeLastSeen)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                Text(item.statement)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .padding(VSpacing.md)
            .background(isHovered ? VColor.surfaceActive : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Kind Badge

    @ViewBuilder
    private var kindBadge: some View {
        let memoryKind = MemoryKind(rawValue: item.kind)
        let color = memoryKind?.color ?? VColor.contentTertiary
        let label = memoryKind?.label ?? item.kind.capitalized

        VBadge(style: .label(label), color: color)
    }
}
