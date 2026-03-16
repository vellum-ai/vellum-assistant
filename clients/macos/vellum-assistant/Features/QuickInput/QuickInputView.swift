import SwiftUI
import VellumAssistantShared

/// Lightweight model for recent conversations shown in the quick input dropdown.
struct QuickInputConversation: Identifiable {
    let id: UUID
    let title: String
}

struct QuickInputView: View {
    @ObservedObject var textModel: QuickInputTextModel
    let onSubmit: (String) -> Void
    let onDismiss: () -> Void
    let onSelectConversation: ((UUID, String) -> Void)?
    let onScreenCapture: (() -> Void)?
    let onRemoveAttachment: (() -> Void)?
    let onAllowScreenRecording: (() -> Void)?
    let onMicrophoneToggle: (() -> Void)?
    let onNotificationToggle: (() -> Void)?
    let recentConversations: [QuickInputConversation]
    let attachedImage: NSImage?
    let showScreenPermissionPrompt: Bool

    @FocusState private var isFocused: Bool
    @State private var isMicPulsing = false

    private let panelWidth: CGFloat = 720

    init(
        textModel: QuickInputTextModel,
        onSubmit: @escaping (String) -> Void,
        onDismiss: @escaping () -> Void,
        onSelectConversation: ((UUID, String) -> Void)? = nil,
        onScreenCapture: (() -> Void)? = nil,
        onRemoveAttachment: (() -> Void)? = nil,
        onAllowScreenRecording: (() -> Void)? = nil,
        onMicrophoneToggle: (() -> Void)? = nil,
        onNotificationToggle: (() -> Void)? = nil,
        recentConversations: [QuickInputConversation] = [],
        attachedImage: NSImage? = nil,
        showScreenPermissionPrompt: Bool = false
    ) {
        self.textModel = textModel
        self.onSubmit = onSubmit
        self.onDismiss = onDismiss
        self.onSelectConversation = onSelectConversation
        self.onScreenCapture = onScreenCapture
        self.onRemoveAttachment = onRemoveAttachment
        self.onAllowScreenRecording = onAllowScreenRecording
        self.onMicrophoneToggle = onMicrophoneToggle
        self.onNotificationToggle = onNotificationToggle
        self.recentConversations = recentConversations
        self.attachedImage = attachedImage
        self.showScreenPermissionPrompt = showScreenPermissionPrompt
    }

    private var isTextEmpty: Bool {
        textModel.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isEmpty: Bool {
        isTextEmpty && attachedImage == nil
    }

    var body: some View {
        VStack(spacing: 0) {
            // Main input bar
            HStack(spacing: VSpacing.md) {
                // Vellum icon
                Self.quickInputIcon
                    .resizable()
                    .interpolation(.high)
                    .antialiased(true)
                    .frame(width: 32, height: 32)

                // Screenshot attachment pill
                if attachedImage != nil {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.scan, size: 11)
                            .foregroundColor(VColor.primaryBase)
                        Text("Screenshot")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.contentDefault)
                        Button(action: { onRemoveAttachment?() }) {
                            VIconView(.x, size: 9)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove image")
                    }
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceActive)
                    )
                }

                // Text field
                TextField(
                    textModel.selectedConversationId != nil
                        ? "Continue where we left off..."
                        : "Type or hold Fn to talk",
                    text: $textModel.text
                )
                    .font(.system(size: 16))
                    .foregroundColor(VColor.contentDefault)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .onSubmit { submit() }
                    .onKeyPress(.escape) {
                        onDismiss()
                        return .handled
                    }

                Spacer(minLength: 0)

                // "New Chat" / thread selector dropdown
                Menu {
                    Button("New Chat") {
                        textModel.selectedConversationId = nil
                        textModel.selectedConversationTitle = nil
                    }

                    if !recentConversations.isEmpty {
                        Divider()

                        ForEach(recentConversations) { thread in
                            Button(thread.title) {
                                onSelectConversation?(thread.id, thread.title)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: VSpacing.xxs) {
                        Text(textModel.selectedConversationTitle ?? "New Chat")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(VColor.contentSecondary)
                            .lineLimit(1)
                        VIconView(.chevronDown, size: 10)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()

                // Notification toggle
                Button(action: { onNotificationToggle?() }) {
                    VIconView(.bell, size: 14)
                        .foregroundColor(textModel.notifyOnComplete ? VColor.contentSecondary : VColor.contentTertiary)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(textModel.notifyOnComplete ? "Notifications on" : "Notifications off")

                // Screenshot button
                if attachedImage == nil {
                    Button(action: { onScreenCapture?() }) {
                        VIconView(.scan, size: 14)
                            .foregroundColor(VColor.contentSecondary)
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Capture screenshot")
                }

                // Mic button (when text is empty) or Send button (when text is present)
                if isTextEmpty && !textModel.isRecording {
                    Button(action: { onMicrophoneToggle?() }) {
                        ZStack {
                            VIconView(.mic, size: 14)
                                .foregroundColor(VColor.primaryBase)
                        }
                        .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Start voice input")
                } else if textModel.isRecording {
                    Button(action: { onMicrophoneToggle?() }) {
                        ZStack {
                            Circle()
                                .fill(VColor.systemNegativeStrong.opacity(0.2))
                                .frame(width: 30, height: 30)
                                .scaleEffect(isMicPulsing ? 1.3 : 1.0)
                                .opacity(isMicPulsing ? 0.0 : 1.0)
                                .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: false), value: isMicPulsing)

                            VIconView(.mic, size: 14)
                                .foregroundColor(VColor.systemNegativeStrong)
                        }
                        .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop recording")
                    .onAppear { isMicPulsing = true }
                    .onDisappear { isMicPulsing = false }
                } else {
                    Button(action: submit) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(isEmpty ? VColor.primaryBase.opacity(0.4) : VColor.primaryBase)
                                .frame(width: 32, height: 32)
                            VIconView(.arrowUp, size: 14)
                                .foregroundColor(VColor.auxWhite)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isEmpty)
                    .accessibilityLabel("Send message")
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)

            // Screen recording permission prompt
            if showScreenPermissionPrompt {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.scan, size: 14)
                        .foregroundColor(VColor.primaryBase)

                    Text("Allow screen recording to capture screenshots")
                        .font(.system(size: 13))
                        .foregroundColor(VColor.contentSecondary)

                    Spacer()

                    Button(action: { onAllowScreenRecording?() }) {
                        Text("Allow")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(VColor.primaryBase)
                            .padding(.horizontal, VSpacing.md)
                            .padding(.vertical, VSpacing.xs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(VColor.borderActive, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.bottom, VSpacing.md)
            }
        }
        .frame(width: panelWidth)
        .background(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .fill(VColor.surfaceBase)
                .shadow(color: VColor.auxBlack.opacity(0.15), radius: 20, y: 4)
                .shadow(color: VColor.auxBlack.opacity(0.08), radius: 2, y: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .onAppear {
            isFocused = true
        }
    }

    /// Loads the QuickInputIcon from the resource bundle's raw xcassets directory.
    /// The bundle doesn't compile xcassets into a .car, so we load the PNG directly.
    private static var quickInputIcon: Image {
        let bundle = ResourceBundle.bundle
        if let url = bundle.url(
            forResource: "quick-input-icon-64",
            withExtension: "png",
            subdirectory: "Assets.xcassets/QuickInputIcon.imageset"
        ), let nsImage = NSImage(contentsOf: url) {
            return Image(nsImage: nsImage)
        }
        // Fallback to system icon
        return VIcon.scan.image
    }

    private func submit() {
        let trimmed = textModel.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || attachedImage != nil else { return }
        onSubmit(trimmed)
    }
}

// MARK: - NSVisualEffectView wrapper

struct VisualEffectBlur: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    let blendingMode: NSVisualEffectView.BlendingMode

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = .active
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blendingMode
    }
}

