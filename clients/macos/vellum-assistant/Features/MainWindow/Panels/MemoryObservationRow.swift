import SwiftUI
import VellumAssistantShared

struct MemoryObservationRow: View {
    let observation: MemoryObservationPayload
    let onDelete: () -> Void
    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            contentText
            footerRow
        }
        .padding(VSpacing.lg)
        .background(isHovered ? VColor.surfaceActive : Color.clear)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Delete", role: .destructive, action: onDelete)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Content

    @ViewBuilder
    private var contentText: some View {
        Text(observation.content)
            .font(VFont.body)
            .foregroundColor(VColor.contentDefault)
            .lineLimit(3)
            .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footerRow: some View {
        HStack(spacing: VSpacing.sm) {
            roleBadge

            if let title = observation.conversationTitle, !title.isEmpty {
                Text(title)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .lineLimit(1)
            }

            Spacer()

            Text(observation.relativeCreatedAt)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            if isHovered {
                VButton(
                    label: "Delete",
                    iconOnly: VIcon.trash.rawValue,
                    style: .dangerGhost,
                    action: onDelete
                )
                .accessibilityLabel("Delete observation")
            }
        }
    }

    // MARK: - Role Badge

    private var roleBadge: some View {
        VBadge(
            label: observation.role.capitalized,
            tone: observation.role == "user" ? .accent : .neutral,
            emphasis: .subtle,
            shape: .pill
        )
    }
}
