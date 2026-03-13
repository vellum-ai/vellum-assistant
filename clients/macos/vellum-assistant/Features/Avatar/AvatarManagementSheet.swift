import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Modal overlay for managing the avatar: build a character, upload, or delete.
struct AvatarManagementSheet: View {
    let onClose: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var showingCharacterBuilder = false
    @State private var draftImage: NSImage?
    @State private var draftBody: AvatarBodyShape?
    @State private var draftEyes: AvatarEyeStyle?
    @State private var draftColor: AvatarColor?

    var body: some View {
        VStack(spacing: 0) {
            // Header with close/back button
            HStack {
                if showingCharacterBuilder {
                    Button {
                        withAnimation(VAnimation.fast) {
                            draftImage = nil
                            draftBody = nil
                            draftEyes = nil
                            draftColor = nil
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
                    subtitle: "Build your own character"
                ) {
                    withAnimation(VAnimation.fast) {
                        draftImage = nil
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
                draftBody = AvatarBodyShape.allCases.randomElement()!
                draftEyes = AvatarEyeStyle.allCases.randomElement()!
                draftColor = AvatarColor.allCases.randomElement()! // color-literal-ok
                renderDraft()
            }
            .padding(.bottom, VSpacing.lg)

            // Cycle controls for body, eyes, and color
            cycleControls
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

    // MARK: - Cycle Helpers

    private func cycleForward<T: CaseIterable & Equatable>(_ current: T?) -> T where T.AllCases.Index == Int {
        let all = Array(T.allCases)
        guard let current, let idx = all.firstIndex(of: current) else { return all[0] }
        return all[(idx + 1) % all.count]
    }

    private func cycleBackward<T: CaseIterable & Equatable>(_ current: T?) -> T where T.AllCases.Index == Int {
        let all = Array(T.allCases)
        guard let current, let idx = all.firstIndex(of: current) else { return all[0] }
        return all[(idx - 1 + all.count) % all.count]
    }

    private func ensureDraftsInitialized() {
        if draftBody == nil || draftEyes == nil || draftColor == nil {
            if draftBody == nil { draftBody = AvatarBodyShape.allCases.first }
            if draftEyes == nil { draftEyes = AvatarEyeStyle.allCases.first }
            if draftColor == nil { draftColor = AvatarColor.allCases.first }
        }
    }

    // MARK: - Cycle Controls

    @ViewBuilder
    private var cycleControls: some View {
        VStack(spacing: VSpacing.sm) {
            cycleRow(
                label: "Body",
                onLeft: {
                    ensureDraftsInitialized()
                    draftBody = cycleBackward(draftBody)
                    renderDraft()
                },
                onRight: {
                    ensureDraftsInitialized()
                    draftBody = cycleForward(draftBody)
                    renderDraft()
                }
            ) {
                if let body = draftBody, let color = draftColor {
                    Image(nsImage: AvatarCompositor.renderBodyOnly(bodyShape: body, color: color, size: 32))
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 32, height: 32)
                }
            }
            cycleRow(
                label: "Eyes",
                onLeft: {
                    ensureDraftsInitialized()
                    draftEyes = cycleBackward(draftEyes)
                    renderDraft()
                },
                onRight: {
                    ensureDraftsInitialized()
                    draftEyes = cycleForward(draftEyes)
                    renderDraft()
                }
            ) {
                if let eyes = draftEyes {
                    Image(nsImage: AvatarCompositor.renderEyesOnly(eyeStyle: eyes, size: 32))
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 32, height: 32)
                }
            }
            cycleRow(
                label: "Color",
                onLeft: {
                    ensureDraftsInitialized()
                    draftColor = cycleBackward(draftColor)
                    renderDraft()
                },
                onRight: {
                    ensureDraftsInitialized()
                    draftColor = cycleForward(draftColor)
                    renderDraft()
                }
            ) {
                Circle()
                    .fill(draftColor.map { Color(nsColor: $0.nsColor) } ?? VColor.contentTertiary)
                    .frame(width: 20, height: 20)
            }
        }
    }

    @ViewBuilder
    private func cycleRow<Content: View>(
        label: String,
        onLeft: @escaping () -> Void,
        onRight: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 0) {
            Button(action: onLeft) {
                VIconView(.chevronLeft, size: 10)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Previous \(label.lowercased())")

            Spacer()

            content()

            Spacer()

            Button(action: onRight) {
                VIconView(.chevronRight, size: 10)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Next \(label.lowercased())")
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.md)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(VColor.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Draft Rendering

    private func renderDraft() {
        guard let body = draftBody, let eyes = draftEyes, let color = draftColor else { return }
        draftImage = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color)
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
