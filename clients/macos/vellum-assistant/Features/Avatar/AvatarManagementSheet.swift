import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Modal overlay for managing the avatar: upload, choose from presets, edit in chat, or delete.
struct AvatarManagementSheet: View {
    let onClose: () -> Void
    let onEditAvatar: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var showingPresets = false

    var body: some View {
        VStack(spacing: 0) {
            // Header with close/back button
            HStack {
                if showingPresets {
                    Button {
                        withAnimation(VAnimation.fast) {
                            showingPresets = false
                        }
                    } label: {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.chevronLeft, size: 10)
                            Text("Back")
                                .font(VFont.bodyMedium)
                        }
                        .foregroundColor(VColor.contentSecondary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("Back to options")
                } else {
                    Text("Update Avatar")
                        .font(VFont.cardTitle)
                        .foregroundColor(VColor.contentDefault)
                }
                Spacer()
                Button(action: onClose) {
                    VIconView(.x, size: 12)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            if showingPresets {
                presetGrid
            } else {
                actionList
            }
        }
        .background(VColor.surfaceBase)
    }

    // MARK: - Action List

    private var actionList: some View {
        Group {
            // Avatar preview
            Image(nsImage: appearance.fullAvatarImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 120, height: 120)
                .clipShape(Circle())
                .padding(.bottom, VSpacing.xl)

            Divider().background(VColor.borderBase)

            // Action rows
            VStack(spacing: 0) {
                actionRow(
                    icon: "square.grid.2x2",
                    label: "Choose from Presets",
                    subtitle: "Pick one of the preset characters"
                ) {
                    withAnimation(VAnimation.fast) {
                        showingPresets = true
                    }
                }

                Divider().background(VColor.borderBase)
                    .padding(.horizontal, VSpacing.xl)

                actionRow(
                    icon: "photo",
                    label: "Upload Image",
                    subtitle: "Choose a PNG or JPEG from your Mac"
                ) {
                    pickImage()
                }

                Divider().background(VColor.borderBase)
                    .padding(.horizontal, VSpacing.xl)

                actionRow(
                    icon: "bubble.left.and.text.bubble.right",
                    label: "Edit in Chat",
                    subtitle: "Describe changes and let AI generate it"
                ) {
                    onEditAvatar()
                }

                if appearance.customAvatarImage != nil {
                    Divider().background(VColor.borderBase)
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
    }

    // MARK: - Preset Grid

    private var presetGrid: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 5),
            spacing: VSpacing.sm
        ) {
            ForEach(PresetAvatar.all) { preset in
                if let image = preset.image {
                    Button {
                        appearance.setCustomAvatar(image)
                        onClose()
                    } label: {
                        Image(nsImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .frame(maxWidth: .infinity)
                            .padding(VSpacing.md)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .fill(VColor.surfaceBase)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.lg)
                                    .stroke(VColor.borderBase, lineWidth: 1)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel(preset.name)
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.bottom, VSpacing.xl)
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
                    .foregroundColor(destructive ? VColor.systemNegativeStrong : VColor.contentSecondary)
                    .frame(width: 24, alignment: .center)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text(label)
                        .font(VFont.bodyMedium)
                        .foregroundColor(destructive ? VColor.systemNegativeStrong : VColor.contentDefault)
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                Spacer()

                VIconView(.chevronRight, size: 11)
                    .foregroundColor(VColor.contentTertiary)
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
