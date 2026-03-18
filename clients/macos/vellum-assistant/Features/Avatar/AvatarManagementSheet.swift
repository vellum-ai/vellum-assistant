import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Modal for managing the user's avatar: build a character, upload an image,
/// or delete the current avatar. Uses VModal's `backAction` to navigate
/// between the action list and the character builder sub-screen.
struct AvatarManagementSheet: View {
    let onClose: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var showingCharacterBuilder = false
    @State private var draftImage: NSImage?
    @State private var draftBody: AvatarBodyShape?
    @State private var draftEyes: AvatarEyeStyle?
    @State private var draftColor: AvatarColor?
    @State private var initialBody: AvatarBodyShape?
    @State private var initialEyes: AvatarEyeStyle?
    @State private var initialColor: AvatarColor?

    var body: some View {
        VModal(
            title: showingCharacterBuilder ? "" : "Update Avatar",
            closeAction: onClose,
            backAction: showingCharacterBuilder ? {
                withAnimation(VAnimation.fast) {
                    draftImage = nil
                    draftBody = nil
                    draftEyes = nil
                    draftColor = nil
                    showingCharacterBuilder = false
                }
            } : nil
        ) {
            if showingCharacterBuilder {
                characterBuilder
            } else {
                actionList
            }
        }
    }

    // MARK: - Action List

    private var actionList: some View {
        VStack(spacing: VSpacing.sm) {
            VAvatarImage(image: appearance.fullAvatarImage, size: 120, showBorder: false)
                .padding(.bottom, VSpacing.md)

            VActionCard(
                icon: "paintbrush",
                label: "Build a Character",
                subtitle: "Build your own character"
            ) {
                withAnimation(VAnimation.fast) {
                    if let body = appearance.characterBodyShape,
                       let eyes = appearance.characterEyeStyle,
                       let color = appearance.characterColor {
                        draftBody = body
                        draftEyes = eyes
                        draftColor = color
                    } else {
                        draftBody = AvatarBodyShape.allCases.randomElement()!
                        draftEyes = AvatarEyeStyle.allCases.randomElement()!
                        draftColor = AvatarColor.allCases.randomElement()! // color-literal-ok
                    }
                    initialBody = draftBody
                    initialEyes = draftEyes
                    initialColor = draftColor
                    renderDraft()
                    showingCharacterBuilder = true
                }
            }

            VActionCard(
                icon: "photo",
                label: "Upload Image",
                subtitle: "Choose a PNG or JPEG from your Mac"
            ) {
                pickImage()
            }

            if appearance.customAvatarImage != nil {
                VActionCard(
                    icon: VIcon.trash.rawValue,
                    label: "Delete Avatar",
                    subtitle: "Revert to the default avatar",
                    destructive: true,
                    showChevron: false
                ) {
                    appearance.clearCustomAvatar()
                    onClose()
                }
            }
        }
    }

    // MARK: - Character Builder

    private var isDirty: Bool {
        guard let body = draftBody, let eyes = draftEyes, let color = draftColor else { return false }
        return body != initialBody || eyes != initialEyes || color != initialColor
    }

    private var characterBuilder: some View {
        VStack(spacing: 0) {
            VAvatarImage(image: draftImage ?? appearance.fullAvatarImage, size: 120, showBorder: false)
                .padding(.bottom, VSpacing.lg)

            VButton(label: "Generate Random", icon: VIcon.dices.rawValue, style: .outlined) {
                draftBody = AvatarBodyShape.allCases.randomElement()!
                draftEyes = AvatarEyeStyle.allCases.randomElement()!
                draftColor = AvatarColor.allCases.randomElement()! // color-literal-ok
                renderDraft()
            }
            .padding(.bottom, VSpacing.lg)

            cycleControls
                .padding(.bottom, VSpacing.lg)

            HStack(spacing: VSpacing.md) {
                VButton(label: "Discard", style: .dangerOutline, isDisabled: !isDirty) {
                    onClose()
                }
                VButton(label: "Confirm", style: .primary, isDisabled: draftImage == nil) {
                    if let draftImage {
                        appearance.saveAvatar(draftImage, bodyShape: draftBody, eyeStyle: draftEyes, color: draftColor)
                    }
                    onClose()
                }
            }
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

    // MARK: - Cycle Controls

    @ViewBuilder
    private var cycleControls: some View {
        VStack(spacing: VSpacing.sm) {
            cycleRow(
                label: "Body",
                value: draftBody?.rawValue.capitalized ?? "None",
                onLeft: {
                    draftBody = cycleBackward(draftBody)
                    if draftEyes == nil { draftEyes = AvatarEyeStyle.allCases.first }
                    if draftColor == nil { draftColor = AvatarColor.allCases.first }
                    renderDraft()
                },
                onRight: {
                    draftBody = cycleForward(draftBody)
                    if draftEyes == nil { draftEyes = AvatarEyeStyle.allCases.first }
                    if draftColor == nil { draftColor = AvatarColor.allCases.first }
                    renderDraft()
                }
            ) {
                if let body = draftBody {
                    Image(nsImage: AvatarCompositor.renderBodyOutline(bodyShape: body, size: 36))
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 36, height: 36)
                }
            }
            cycleRow(
                label: "Eyes",
                value: draftEyes?.rawValue.capitalized ?? "None",
                onLeft: {
                    draftEyes = cycleBackward(draftEyes)
                    if draftBody == nil { draftBody = AvatarBodyShape.allCases.first }
                    if draftColor == nil { draftColor = AvatarColor.allCases.first }
                    renderDraft()
                },
                onRight: {
                    draftEyes = cycleForward(draftEyes)
                    if draftBody == nil { draftBody = AvatarBodyShape.allCases.first }
                    if draftColor == nil { draftColor = AvatarColor.allCases.first }
                    renderDraft()
                }
            ) {
                if let eyes = draftEyes {
                    Image(nsImage: AvatarCompositor.renderEyesOnly(eyeStyle: eyes, size: 56))
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 56, height: 56)
                }
            }
            cycleRow(
                label: "Color",
                value: draftColor?.rawValue.capitalized ?? "None",
                onLeft: {
                    draftColor = cycleBackward(draftColor)
                    if draftBody == nil { draftBody = AvatarBodyShape.allCases.first }
                    if draftEyes == nil { draftEyes = AvatarEyeStyle.allCases.first }
                    renderDraft()
                },
                onRight: {
                    draftColor = cycleForward(draftColor)
                    if draftBody == nil { draftBody = AvatarBodyShape.allCases.first }
                    if draftEyes == nil { draftEyes = AvatarEyeStyle.allCases.first }
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
        value: String,
        onLeft: @escaping () -> Void,
        onRight: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 0) {
            Button(action: onLeft) {
                VIconView(.arrowLeft, size: 14)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Previous \(label.lowercased())")

            Spacer()

            content()
                .accessibilityHidden(true)

            Spacer()

            Button(action: onRight) {
                VIconView(.arrowRight, size: 14)
                    .foregroundColor(VColor.contentTertiary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerCursor()
            .accessibilityLabel("Next \(label.lowercased())")
        }
        .padding(.horizontal, VSpacing.sm)
        .frame(maxWidth: .infinity)
        .frame(height: 52)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(VColor.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
        .accessibilityValue(value)
    }

    // MARK: - Draft Rendering

    private func renderDraft() {
        guard let body = draftBody, let eyes = draftEyes, let color = draftColor else { return }
        draftImage = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color)
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
        appearance.saveAvatar(image)
        onClose()
    }
}
