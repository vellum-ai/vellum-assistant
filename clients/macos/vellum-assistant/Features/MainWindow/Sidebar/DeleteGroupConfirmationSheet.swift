import SwiftUI
import VellumAssistantShared

struct DeleteGroupConfirmationSheet: View {
    let groupName: String
    var onDelete: () -> Void
    var onArchiveAndDelete: () -> Void
    var onCancel: () -> Void

    @State private var archiveConversations = false

    var body: some View {
        VModal(title: "Delete \"\(groupName)\"?") {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Choose what happens to the conversations in this group.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)

                VStack(spacing: VSpacing.sm) {
                    optionRow(
                        selected: !archiveConversations,
                        label: "Keep conversations",
                        description: "Conversations will be moved to the main list"
                    ) {
                        archiveConversations = false
                    }

                    optionRow(
                        selected: archiveConversations,
                        label: "Archive conversations",
                        description: "Conversations will be archived"
                    ) {
                        archiveConversations = true
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    onCancel()
                }
                VButton(label: "Delete group", style: .danger) {
                    if archiveConversations {
                        onArchiveAndDelete()
                    } else {
                        onDelete()
                    }
                }
            }
        }
        .frame(width: 380)
    }

    // MARK: - Radio Option Row

    @ViewBuilder
    private func optionRow(
        selected: Bool,
        label: String,
        description: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                Image(systemName: selected ? "circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(selected ? VColor.primaryBase : VColor.contentTertiary)
                    .frame(width: 18, height: 18)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(label)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                    Text(description)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(selected ? VColor.surfaceBase : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }
}
