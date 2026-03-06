import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Modal overlay for managing the avatar: upload, edit in chat, or delete.
struct AvatarManagementSheet: View {
    let onClose: () -> Void
    let onEditAvatar: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared

    var body: some View {
        VStack(spacing: 0) {
            // Header with close button
            HStack {
                Text("Update Avatar")
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button(action: onClose) {
                    VIconView(.x, size: 12)
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            // Avatar preview
            Image(nsImage: appearance.fullAvatarImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 120, height: 120)
                .clipShape(Circle())
                .padding(.bottom, VSpacing.xl)

            Divider().background(VColor.surfaceBorder)

            // Action rows
            VStack(spacing: 0) {
                actionRow(
                    icon: "photo",
                    label: "Upload Image",
                    subtitle: "Choose a PNG or JPEG from your Mac"
                ) {
                    pickImage()
                }

                Divider().background(VColor.surfaceBorder)
                    .padding(.horizontal, VSpacing.xl)

                actionRow(
                    icon: "bubble.left.and.text.bubble.right",
                    label: "Edit in Chat",
                    subtitle: "Describe changes and let AI generate it"
                ) {
                    onEditAvatar()
                }

                if appearance.customAvatarImage != nil {
                    Divider().background(VColor.surfaceBorder)
                        .padding(.horizontal, VSpacing.xl)

                    actionRow(
                        icon: VIcon.trash.rawValue,
                        label: "Delete Avatar",
                        subtitle: "Revert to the default avatar",
                        destructive: true
                    ) {
                        appearance.clearCustomAvatar()
                        onClose()
                    }
                }
            }
            .padding(.vertical, VSpacing.sm)
        }
        .background(VColor.backgroundSubtle)
    }

    // MARK: - Action Row

    @ViewBuilder
    private func actionRow(
        icon: String,
        label: String,
        subtitle: String,
        destructive: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 14)
                    .foregroundColor(destructive ? VColor.error : VColor.textSecondary)
                    .frame(width: 24, alignment: .center)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(label)
                        .font(VFont.bodyMedium)
                        .foregroundColor(destructive ? VColor.error : VColor.textPrimary)
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Spacer()

                VIconView(.chevronRight, size: 11)
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.md)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - File Picker

    private func pickImage() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .gif, .heic]
        panel.message = "Choose a profile picture"

        guard panel.runModal() == .OK, let url = panel.url,
              let image = NSImage(contentsOf: url) else { return }
        appearance.setCustomAvatar(image)
        onClose()
    }
}
