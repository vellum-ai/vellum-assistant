import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Side panel for customizing the avatar's profile picture.
struct AvatarCustomizationPanel: View {
    let onClose: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    Button(action: onClose) {
                        VIconView(.chevronLeft, size: 14)
                            .foregroundStyle(VColor.contentSecondary)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Back to identity")
                    Text("Customize Avatar")
                        .font(VFont.titleLarge)
                        .foregroundStyle(VColor.contentDefault)
                    Spacer()
                }
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)

                Divider().background(VColor.borderBase)
                    .padding(.bottom, VSpacing.xl)

                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Avatar preview
                    HStack {
                        Spacer()
                        VAvatarImage(image: appearance.fullAvatarImage, size: 120, showBorder: false)
                        Spacer()
                    }

                    // Profile picture section
                    profilePictureSection
                }

                Spacer(minLength: VSpacing.xxl)
            }
            .frame(maxWidth: 600)
            .padding(.horizontal, VSpacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .background(VColor.surfaceBase)
    }

    // MARK: - Profile Picture

    @ViewBuilder
    private var profilePictureSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Profile Picture")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentSecondary)

            if let customImage = appearance.customAvatarImage {
                HStack(spacing: VSpacing.md) {
                    VAvatarImage(image: customImage, size: 48, showBorder: false)

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Button("Change") { pickImage() }
                            .buttonStyle(.plain)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.primaryBase)

                        Button("Remove") { appearance.clearCustomAvatar() }
                            .buttonStyle(.plain)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
            } else {
                Button {
                    pickImage()
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.image, size: 12)
                        Text("Upload Custom Image")
                            .font(VFont.bodyMediumDefault)
                    }
                    .foregroundStyle(VColor.contentSecondary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func pickImage() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .webP, .gif, .heic]
        panel.message = "Choose a profile picture"

        guard panel.runModal() == .OK, let url = panel.url,
              let image = NSImage(contentsOf: url) else { return }
        appearance.saveAvatar(image)
    }
}
