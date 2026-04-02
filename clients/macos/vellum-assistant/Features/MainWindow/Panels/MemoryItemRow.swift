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

    private var accentColor: Color {
        memoryKind?.color ?? VColor.contentTertiary
    }

    var body: some View {
        VCard(action: onSelect) {
            HStack(spacing: 0) {
                // Accent bar
                RoundedRectangle(cornerRadius: 2)
                    .fill(accentColor)
                    .frame(width: 4)

                // Content area
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    // Top row: subject + timestamp + delete
                    HStack(alignment: .center, spacing: VSpacing.sm) {
                        Text(item.subject)
                            .font(VFont.brandMini)
                            .foregroundStyle(VColor.contentEmphasized)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        Spacer()

                        Text(item.relativeLastSeen)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        if isHovered {
                            VButton(
                                label: "Delete",
                                iconOnly: VIcon.trash.rawValue,
                                style: .dangerGhost,
                                size: .compact,
                                action: onDelete
                            )
                            .accessibilityLabel("Delete memory")
                        }
                    }

                    // Metadata row: kind tag + confidence + source + importance dots
                    HStack(alignment: .center, spacing: VSpacing.xs) {
                        VTag(
                            memoryKind?.label ?? item.kind.capitalized,
                            color: accentColor
                        )

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

                        // Importance dots
                        HStack(spacing: 2) {
                            ForEach(0..<item.importanceLevel.rawValue, id: \.self) { _ in
                                Circle()
                                    .fill(VColor.contentTertiary)
                                    .frame(width: 8, height: 8)
                            }
                        }
                    }
                }
                .padding(.leading, VSpacing.md)
            }
            .background(memoryKind?.backgroundTint ?? Color.clear)
        }
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }
}
