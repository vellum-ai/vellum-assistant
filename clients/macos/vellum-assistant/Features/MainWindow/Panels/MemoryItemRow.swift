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
        VInteractiveCard(action: onSelect) {
            HStack(alignment: .center, spacing: VSpacing.lg) {
                kindIcon

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(item.subject)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.contentDefault)
                                .lineLimit(1)
                                .truncationMode(.tail)

                            Text(item.relativeLastSeen)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .padding(.top, -1)
                        }

                        Spacer()

                        kindTag

                        if let scopeLabel = item.scopeLabel {
                            VTag(scopeLabel, color: VColor.contentSecondary, icon: .lock)
                        }

                        VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .dangerGhost, action: onDelete)
                            .accessibilityLabel("Delete memory")
                    }

                    Text(item.statement)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                        .multilineTextAlignment(.leading)
                }
            }
        }
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
        VTag(
            memoryKind?.label ?? item.kind.capitalized,
            color: memoryKind?.color ?? VColor.contentTertiary
        )
    }
}
