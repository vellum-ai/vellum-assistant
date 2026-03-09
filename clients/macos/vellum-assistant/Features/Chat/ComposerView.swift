import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

struct ComposerView: View {
    private let composerMaxHeight: CGFloat = 200
    private let composerActionButtonSize: CGFloat = 34

    @Binding var inputText: String
    let hasAPIKey: Bool
    let isSending: Bool
    let hasPendingConfirmation: Bool
    var onAllowPendingConfirmation: (() -> Void)? = nil
    let isRecording: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    var isLoadingAttachment: Bool = false
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onPaste: () -> Void
    let onFileDrop: ([URL]) -> Void
    let onDropImageData: ((Data, String?) -> Void)?
    let onMicrophoneToggle: () -> Void
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var placeholderText: String = "What would you like to do?"
    var composerCompactHeight: CGFloat = 34
    var threadId: UUID?

    @Environment(\.conversationZoomScale) private var zoomScale
    @Environment(\.cmdEnterToSend) private var cmdEnterToSend
    @FocusState private var composerFocus: Bool
    @State private var isComposerFocused = false

    @State var showSlashMenu = false
    @State var slashFilter = ""
    @State var slashSelectedIndex = 0
    @State var suppressSlashReopen = false
    @State private var avatarSeed: String = "default"

    private var isVoiceModeActive: Bool {
        voiceModeManager.map { $0.state != .off } ?? false
    }

    /// The portion of the suggestion that extends beyond the current input.
    private var ghostSuffix: String? {
        guard let suggestion else { return nil }
        if suggestion.hasPrefix(inputText) {
            let suffix = String(suggestion.dropFirst(inputText.count))
            return suffix.isEmpty ? nil : suffix
        }
        if inputText.isEmpty { return suggestion }
        return nil
    }

    var body: some View {
        VStack(spacing: VSpacing.sm) {
            // Slash command popup (above the composer)
            if showSlashMenu {
                SlashCommandPopup(
                    commands: filteredSlashCommands(slashFilter),
                    selectedIndex: slashSelectedIndex,
                    onSelect: { command in selectSlashCommand(command) }
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // Composer box
            VStack(spacing: 0) {
                if !pendingAttachments.isEmpty {
                    attachmentStrip
                }

                if isVoiceModeActive {
                    // Voice mode: replace text field with live transcription + voice controls
                    HStack(alignment: .center, spacing: VSpacing.md) {
                        voiceModeContent
                            .frame(maxWidth: .infinity, alignment: .leading)
                        voiceModeActionButtons
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                    .frame(height: compactRowHeight, alignment: .center)
                } else {
                    composerTextField
                        .frame(minHeight: composerCompactHeight)
                        .overlay(alignment: .bottomTrailing) {
                            composerActionButtons
                        }
                }
            }
            .padding(.top, VSpacing.sm)
            .padding(.bottom, VSpacing.sm)
            .padding(.leading, VSpacing.lg)
            .padding(.trailing, VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.composerBackground)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(
                        isComposerFocused ? VColor.surfaceBorder : VColor.surfaceBorder.opacity(0.95),
                        lineWidth: isComposerFocused ? 1.5 : 1
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder.opacity(isComposerFocused ? 0.12 : 0), lineWidth: 3)
            )
            .shadow(color: .clear, radius: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .animation(VAnimation.fast, value: showSlashMenu)
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, VSpacing.sm)
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity)
        .animation(VAnimation.fast, value: isComposerFocused)
        .onAppear {
            composerFocus = true
            let identity = IdentityInfo.load()
            avatarSeed = identity?.name ?? "default"
        }
        .onChange(of: threadId) {
            guard !hasPendingConfirmation else { return }
            composerFocus = true
        }
    }

    private var compactRowHeight: CGFloat {
        composerActionButtonSize
    }

    /// The text overlays (slash highlighting, ghost text) rendered behind / on
    /// top of the TextField inside the ZStack. Extracted to its own builder so
    /// the compiler can type-check the ZStack body in reasonable time.
    @ViewBuilder
    private func composerTextOverlays(font: Font, hasSlashHighlight: Bool) -> some View {
        // Slash command highlighting overlay — renders the full input
        // with the /command prefix in the accent color. The TextField
        // below is made transparent so this overlay provides the
        // visible text coloring.
        if hasSlashHighlight {
            Text(slashHighlightedText(font: font))
                .lineLimit(1...)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }

        // Ghost text overlay (invisible matching input + visible suffix)
        if let ghostSuffix {
            (Text(inputText)
                .font(font)
                .foregroundColor(.clear)
            + Text(ghostSuffix)
                .font(font)
                .foregroundColor(VColor.textSecondary.opacity(0.55)))
                .lineLimit(1...)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// The native TextField with keyboard handlers. Extracted so the compiler
    /// can type-check each builder method independently.
    @ViewBuilder
    private func composerInputField(font: Font, hasSlashHighlight: Bool) -> some View {
        TextField(
            ghostSuffix == nil ? placeholderText : "",
            text: $inputText,
            axis: .vertical
        )
        .lineLimit(1...)
        .textFieldStyle(.plain)
        .font(font)
        .foregroundColor(hasSlashHighlight ? .clear : VColor.textPrimary)
        .tint(VColor.accent)
        .focused($composerFocus)
        .disabled(!hasAPIKey)
        .onSubmit { handleComposerSubmit() }
        .onKeyPress(.tab, phases: .down) { press in
            if !press.modifiers.contains(.shift), showSlashMenu {
                handleSlashNavigation(.tab)
                return .handled
            }
            if !press.modifiers.contains(.shift), ghostSuffix != nil {
                onAcceptSuggestion()
                return .handled
            }
            return .ignored
        }
        .onKeyPress(.upArrow) {
            if showSlashMenu {
                handleSlashNavigation(.up)
                return .handled
            }
            return .ignored
        }
        .onKeyPress(.downArrow) {
            if showSlashMenu {
                handleSlashNavigation(.down)
                return .handled
            }
            return .ignored
        }
        .onKeyPress(.escape) {
            if showSlashMenu {
                handleSlashNavigation(.dismiss)
                return .handled
            }
            return .ignored
        }
    }

    private var composerTextField: some View {
        let scaledBody = Font.custom("Inter", size: 13 * zoomScale)
        let hasSlashHighlight = slashCommandRange != nil

        return ScrollView(.vertical, showsIndicators: false) {
            ZStack(alignment: .leading) {
                composerTextOverlays(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
                composerInputField(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
            }
            .frame(maxWidth: .infinity, minHeight: composerCompactHeight, alignment: .leading)
            .padding(.trailing, 70)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(minHeight: composerCompactHeight, maxHeight: inputText.isEmpty ? composerCompactHeight : composerMaxHeight)
        .accessibilityLabel("Message")
        .frame(maxWidth: .infinity)
        .background(
            ComposerFocusBridge(
                isFocused: composerFocus,
                cmdEnterToSend: cmdEnterToSend,
                onImagePaste: onPaste,
                onSend: {
                    performSendAction()
                },
                onRedirectKeystroke: { chars in
                    inputText += chars
                    composerFocus = true
                }
            )
        )
        .onChange(of: composerFocus) {
            isComposerFocused = composerFocus
            if composerFocus {
                if let window = NSApp.keyWindow as? TitleBarZoomableWindow {
                    window.clearComposerDismissed()
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            guard !hasPendingConfirmation else { return }
            guard let window = NSApp.keyWindow as? TitleBarZoomableWindow else { return }
            if let responder = window.firstResponder as? NSView,
               responder != window.contentView,
               window.composerContainerView.map({ !responder.isDescendant(of: $0) }) ?? false {
                return
            }
            composerFocus = true
        }
        .onChange(of: inputText) {
            if inputText.isEmpty {
                withAnimation(VAnimation.fast) { showSlashMenu = false }
            } else {
                updateSlashState()
            }
        }
        .onDrop(of: [.fileURL, .image, .png, .tiff], isTargeted: nil) { providers in
            let group = DispatchGroup()
            // Collect URLs on the main queue to avoid concurrent Array mutation
            // from loadObject callbacks that may fire on different threads.
            var urls: [URL] = []
            var imageDataItems: [NSItemProvider] = []
            for provider in providers {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    let hasImageFallback = provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier)
                    group.enter()
                    _ = provider.loadObject(ofClass: URL.self) { url, _ in
                        DispatchQueue.main.async {
                            if let url, FileManager.default.fileExists(atPath: url.path) {
                                urls.append(url)
                                group.leave()
                            } else if hasImageFallback, let onDropImageData {
                                let typeIdentifier: String
                                if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                                    typeIdentifier = UTType.png.identifier
                                } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                                    typeIdentifier = UTType.tiff.identifier
                                } else {
                                    typeIdentifier = UTType.image.identifier
                                }
                                let suggestedName = provider.suggestedName
                                provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                                    DispatchQueue.main.async {
                                        if let data {
                                            onDropImageData(data, suggestedName)
                                        }
                                        group.leave()
                                    }
                                }
                            } else {
                                group.leave()
                            }
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                            || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                            || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                    imageDataItems.append(provider)
                }
            }
            if let onDropImageData {
                for provider in imageDataItems {
                    let typeIdentifier: String
                    if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                        typeIdentifier = UTType.png.identifier
                    } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                        typeIdentifier = UTType.tiff.identifier
                    } else {
                        typeIdentifier = UTType.image.identifier
                    }
                    let suggestedName = provider.suggestedName
                    group.enter()
                    provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                        DispatchQueue.main.async {
                            if let data {
                                onDropImageData(data, suggestedName)
                            }
                            group.leave()
                        }
                    }
                }
            }
            group.notify(queue: .main) {
                if !urls.isEmpty { onFileDrop(urls) }
            }
            return true
        }
    }

    /// Shared send logic used by `.onSubmit` (native Return-to-send) and the
    /// AppKit `ComposerFocusBridge` Cmd+Enter interception. Keeps slash-menu
    /// selection, ghost-text acceptance, and pending-confirmation approval
    /// all working regardless of how "send" is triggered.
    private func performSendAction() {
        inputText = inputText.replacingOccurrences(
            of: "\\n$", with: "", options: .regularExpression
        )
        if ghostSuffix != nil { onAcceptSuggestion() }
        if showSlashMenu {
            handleSlashNavigation(.select)
        } else if canSend {
            onSend()
        } else if hasPendingConfirmation
                    && inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            onAllowPendingConfirmation?()
        }
    }

    private func handleComposerSubmit() {
        #if os(macOS)
        // `.onSubmit` fires on all Return variants, so keep the actual
        // send-vs-newline behavior in the shared return-key contract.
        ComposerReturnKeyRouting.handleSubmit(
            cmdEnterToSend: cmdEnterToSend,
            textView: NSApp.keyWindow?.firstResponder as? NSTextView
        ) {
            performSendAction()
        }
        #else
        performSendAction()
        #endif
    }

    @ViewBuilder
    private var composerActionButtons: some View {
        HStack(spacing: 2) {
            if isSending && !hasPendingConfirmation {
                VIconButton(
                    label: "Stop generation",
                    icon: VIcon.square.rawValue,
                    iconOnly: true,
                    variant: .neutral,
                    size: composerActionButtonSize,
                    action: onStop
                )
            } else {
                VIconButton(
                    label: "Attach file",
                    icon: VIcon.paperclip.rawValue,
                    iconOnly: true,
                    size: composerActionButtonSize,
                    action: { onAttach() }
                )
                .disabled(!hasAPIKey)

                if canSend {
                    VIconButton(
                        label: "Send message",
                        icon: VIcon.arrowUp.rawValue,
                        iconOnly: true,
                        variant: .primary,
                        size: composerActionButtonSize
                    ) {
                        composerFocus = true
                        onSend()
                    }
                    .transition(.scale.combined(with: .opacity))
                } else {
                    MicrophoneButton(
                        isRecording: isRecording,
                        size: composerActionButtonSize,
                        action: { onMicrophoneToggle() }
                    )
                    .disabled(!hasAPIKey)
                    .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .padding(.trailing, -(VSpacing.lg - VSpacing.sm))
        .animation(VAnimation.spring, value: canSend)
    }

    // MARK: - Voice Mode Content

    @ViewBuilder
    private var voiceModeContent: some View {
        if let manager = voiceModeManager {
            HStack(spacing: VSpacing.sm) {
                // Waveform icon
                VIconView(.audioWaveform, size: 14)
                    .foregroundColor(voiceModeIconColor(manager))

                if manager.state == .listening, !manager.liveTranscription.isEmpty {
                    Text(manager.liveTranscription)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.head)
                } else {
                    Text(manager.stateLabel)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            }
        }
    }

    @ViewBuilder
    private var voiceModeActionButtons: some View {
        if let manager = voiceModeManager, let voiceService {
            HStack(spacing: 2) {
                // Waveform amplitude dots
                voiceModeWaveform(manager: manager, voiceService: voiceService)
                    .frame(width: 28, height: composerActionButtonSize)

                // Mute / unmute
                VIconButton(
                    label: manager.state == .listening ? "Mute" : "Unmute",
                    icon: manager.state == .listening ? VIcon.mic.rawValue : VIcon.micOff.rawValue,
                    iconOnly: true,
                    size: composerActionButtonSize,
                    action: { manager.toggleListening() }
                )
                .disabled(manager.state == .processing)

                // End voice mode (red X)
                VIconButton(
                    label: "End voice mode",
                    icon: VIcon.x.rawValue,
                    iconOnly: true,
                    variant: .danger,
                    size: composerActionButtonSize,
                    action: { onEndVoiceMode?() }
                )
            }
            .padding(.trailing, -(VSpacing.lg - VSpacing.sm))
        }
    }

    private func voiceModeWaveform(manager: VoiceModeManager, voiceService: OpenAIVoiceService) -> some View {
        HStack(spacing: 2) {
            ForEach(0..<4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1)
                    .fill(voiceModeIconColor(manager))
                    .frame(width: 3, height: voiceModeBarHeight(index: i, manager: manager, voiceService: voiceService))
                    .animation(.easeInOut(duration: 0.12), value: voiceService.amplitude)
                    .animation(.easeInOut(duration: 0.3), value: voiceService.speakingAmplitude)
            }
        }
    }

    private func voiceModeBarHeight(index: Int, manager: VoiceModeManager, voiceService: OpenAIVoiceService) -> CGFloat {
        let amp: Float
        switch manager.state {
        case .listening: amp = voiceService.amplitude
        case .speaking: amp = voiceService.speakingAmplitude
        default: return 4
        }
        let base: CGFloat = 4
        let maxExtra: CGFloat = 14
        let offset = Float(index) * 0.2
        let value = min(max(amp + offset * amp, 0), 1)
        return base + CGFloat(value) * maxExtra
    }

    private func voiceModeIconColor(_ manager: VoiceModeManager) -> Color {
        switch manager.state {
        case .listening: return VColor.accent
        case .speaking: return VColor.success
        case .processing: return VColor.textSecondary
        default: return Moss._500
        }
    }

    var canSend: Bool {
        // Block send while an attachment is still loading: the user tapping Send
        // before the async load completes would drop the attachment from the message.
        hasAPIKey
            && !isLoadingAttachment
            && (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty)
    }

}
