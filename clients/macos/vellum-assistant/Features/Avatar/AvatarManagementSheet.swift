import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Modal overlay for managing the avatar: build a character, upload, or delete.
struct AvatarManagementSheet: View {
    let onClose: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var showingCharacterBuilder = false
    @State private var draftImage: NSImage?
    @State private var selectedPresetID: String?

    var body: some View {
        VStack(spacing: 0) {
            // Header with close/back button
            HStack {
                if showingCharacterBuilder {
                    Button {
                        withAnimation(VAnimation.fast) {
                            draftImage = nil
                            selectedPresetID = nil
                            showingCharacterBuilder = false
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

            if showingCharacterBuilder {
                characterBuilder
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
            VAvatarImage(image: appearance.fullAvatarImage, size: 120, showBorder: false)
                .padding(.bottom, VSpacing.xl)

            Divider().background(VColor.borderBase)

            // Action rows
            VStack(spacing: 0) {
                actionRow(
                    icon: "paintbrush",
                    label: "Build a Character",
                    subtitle: "Choose or randomize a preset character"
                ) {
                    withAnimation(VAnimation.fast) {
                        draftImage = nil
                        selectedPresetID = nil
                        showingCharacterBuilder = true
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

    // MARK: - Character Builder

    private var characterBuilder: some View {
        VStack(spacing: 0) {
            // Draft avatar preview
            VAvatarImage(image: draftImage ?? appearance.fullAvatarImage, size: 120, showBorder: false)
                .padding(.bottom, VSpacing.lg)

            // Generate Random button
            VButton(label: "Generate Random", icon: "dice", style: .outlined) {
                let body = AvatarBodyShape.allCases.randomElement()!
                let eyes = AvatarEyeStyle.allCases.randomElement()!
                let color = AvatarColor.allCases.randomElement()! // color-literal-ok
                draftImage = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color)
                selectedPresetID = nil
            }
            .padding(.bottom, VSpacing.lg)

            // Preset grid
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 5),
                spacing: VSpacing.sm
            ) {
                ForEach(PresetAvatar.all) { preset in
                    if let image = preset.image {
                        Button {
                            draftImage = image
                            selectedPresetID = preset.id
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
                                        .stroke(
                                            selectedPresetID == preset.id ? VColor.primaryBase : VColor.borderBase,
                                            lineWidth: selectedPresetID == preset.id ? 2 : 1
                                        )
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
            .padding(.bottom, VSpacing.lg)

            // Confirm and Discard buttons
            HStack(spacing: VSpacing.md) {
                VButton(label: "Discard", style: .outlined) {
                    onClose()
                }
                VButton(label: "Confirm", style: .primary, isDisabled: draftImage == nil) {
                    if let draftImage {
                        appearance.setCustomAvatar(draftImage)
                    }
                    onClose()
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)
        }
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
