import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

struct ComposerView: View {
    private let composerMaxHeight: CGFloat = 200
    private let composerActionButtonSize: CGFloat = 34
    private let composerActionIconSize: CGFloat = 14
    private let compactActionOpticalYOffset: CGFloat = 0

    private enum ComposerActionFocus: Hashable {
        case stop
        case send
        case microphone
        case attachment
    }

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
    /// Bound to ChatView's state so it can compute composerReservedHeight for safe area insets.
    @Binding var editorContentHeight: CGFloat

    /// Exposed to ChatView so composerReservedHeight stays in sync with the
    /// sticky expansion state (set true when text wraps, reset when text clears).
    @Binding var isComposerExpanded: Bool

    @Environment(\.conversationZoomScale) private var zoomScale
    @Environment(\.cmdEnterToSend) private var cmdEnterToSend
    @FocusState private var composerFocus: Bool
    @State private var isStopHovered = false
    @State private var isSendHovered = false
    @State private var isMicrophoneHovered = false
    @State private var isAttachmentHovered = false
    @State private var isComposerFocused = false
    @FocusState private var focusedComposerAction: ComposerActionFocus?

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
                    // Text field with action buttons pinned to bottom-trailing.
                    composerTextField
                        .frame(minHeight: composerCompactHeight)
                        .overlay(alignment: .bottomTrailing) {
                            composerActionButtons
                                .padding(.bottom, VSpacing.xs)
                        }
                }
            }
            .padding(.top, isComposerExpanded ? VSpacing.md : VSpacing.sm)
            .padding(.bottom, VSpacing.sm)
            .padding(.leading, VSpacing.lg)
            .padding(.trailing, VSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(adaptiveColor(light: Moss._200, dark: Moss._700))
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
        .frame(maxWidth: 700)
        .frame(maxWidth: .infinity)
        .animation(VAnimation.fast, value: isComposerExpanded)
        .animation(VAnimation.fast, value: isComposerFocused)
        .onAppear {
            composerFocus = true
            let identity = IdentityInfo.load()
            avatarSeed = identity?.name ?? "default"
        }
    }

    // isComposerExpanded is a @Binding — sticky latch set true when text
    // wraps past a single line, reset when text clears. Prevents layout
    // oscillation and keeps ChatView.composerReservedHeight in sync.

    private var clampedComposerHeight: CGFloat {
        min(max(editorContentHeight, composerCompactHeight), composerMaxHeight)
    }

    private var compactRowHeight: CGFloat {
        max(clampedComposerHeight, composerActionButtonSize)
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
                .lineLimit(1...100)
                .fixedSize(horizontal: false, vertical: true)
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
                .lineLimit(1...100)
                .fixedSize(horizontal: false, vertical: true)
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
        .lineLimit(1...100)
        .textFieldStyle(.plain)
        .font(font)
        .foregroundColor(hasSlashHighlight ? .clear : VColor.textPrimary)
        .tint(VColor.accent)
        .focused($composerFocus)
        .disabled(!hasAPIKey)
        .onKeyPress(.return, phases: .down) { press in
            handleReturnKeyPress(modifiers: press.modifiers)
        }
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
            .frame(maxWidth: .infinity, alignment: .leading)
            // Reserve space so the last line of text isn't hidden behind the
            // overlaid action buttons (attach + send/mic ≈ composerActionButtonSize).
            .padding(.bottom, isComposerExpanded ? composerActionButtonSize : 0)
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityLabel("Message")
        .frame(maxWidth: .infinity, maxHeight: composerMaxHeight, alignment: .topLeading)
        .background(
            GeometryReader { geo in
                Color.clear.preference(key: ComposerEditorHeightKey.self, value: geo.size.height)
            }
        )
        .onPreferenceChange(ComposerEditorHeightKey.self) { newHeight in
            editorContentHeight = newHeight
        }
        .background(
            ComposerFocusBridge(
                isFocused: composerFocus,
                cmdEnterToSend: cmdEnterToSend,
                onImagePaste: onPaste,
                onCmdEnterSend: {
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
            // Auto-focus the composer on app reactivation so the user can
            // start typing immediately after cmd+tab or Dock click.
            guard !hasPendingConfirmation else { return }
            // Only claim focus when the main window is key. If a floating
            // panel or other window is frontmost, skip to avoid intercepting
            // shortcuts (Cmd+V, Cmd+Enter) in the wrong context.
            guard let window = NSApp.keyWindow as? TitleBarZoomableWindow else { return }
            // Preserve focus if another input (NSTextView, WKWebView, etc.)
            // already owns first-responder status in split-panel mode.
            if let responder = window.firstResponder as? NSView,
               responder != window.contentView,
               window.composerContainerView.map({ !responder.isDescendant(of: $0) }) ?? false {
                return
            }
            composerFocus = true
        }
        .onChange(of: inputText) {
            if inputText.isEmpty {
                withAnimation(VAnimation.fast) { isComposerExpanded = false }
                withAnimation(VAnimation.fast) { showSlashMenu = false }
            } else {
                updateSlashState()
            }
        }
        .onChange(of: editorContentHeight) {
            // Only expand — never collapse based on height alone.
            // Collapsing is handled when inputText becomes empty (see above).
            if editorContentHeight > composerCompactHeight && !isComposerExpanded {
                withAnimation(VAnimation.fast) { isComposerExpanded = true }
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

    /// Shared send logic used by both the SwiftUI `.onKeyPress` return handler
    /// and the AppKit `ComposerFocusBridge` Cmd+Enter interception. Keeps the
    /// two paths in sync so slash-menu selection, ghost-text acceptance, and
    /// pending-confirmation approval all work regardless of how "send" is triggered.
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

    /// Handles Return key press: send vs insert newline depending on mode.
    ///
    /// Only the four semantic modifiers (Shift, Command, Control, Option) are
    /// considered when deciding whether the user pressed a "plain" Return.
    /// Non-semantic flags like `.capsLock` and `.numericPad` are ignored so
    /// that Caps Lock being on or pressing Return on the numeric keypad still
    /// behaves as a plain Return.
    private func handleReturnKeyPress(modifiers: EventModifiers) -> KeyPress.Result {
        let semanticModifiers = modifiers.intersection([.shift, .command, .control, .option])

        // Shift+Enter always inserts a newline
        if semanticModifiers.contains(.shift) { return .ignored }

        if cmdEnterToSend {
            // In Cmd+Enter mode: Cmd+Enter sends, plain Enter inserts newline.
            // Cmd+Enter as a key equivalent is handled by ComposerFocusBridge's
            // event monitor; if it also reaches here, handle it.
            if semanticModifiers.contains(.command) {
                performSendAction()
                return .handled
            }
            if semanticModifiers.isEmpty { return .ignored } // plain Enter inserts newline
            return .handled // consume other modifier+Return combos silently
        }

        // Default mode: plain Enter sends, modifier+Return inserts newline
        if semanticModifiers.isEmpty {
            performSendAction()
            return .handled
        }
        return .ignored
    }

    @ViewBuilder
    private var composerActionButtons: some View {
        HStack(spacing: 2) {
            if isSending && !hasPendingConfirmation {
                Button(action: onStop) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(VColor.textPrimary)
                            .frame(width: 30, height: 30)
                        RoundedRectangle(cornerRadius: VRadius.xs)
                            .fill(VColor.surface)
                            .frame(width: 10, height: 10)
                    }
                }
                .buttonStyle(VIconButtonStyle(
                    isHovered: isStopHovered,
                    isFocused: focusedComposerAction == .stop,
                    size: composerActionButtonSize
                ))
                .focused($focusedComposerAction, equals: .stop)
                .focusable(true)
                .onHover { hovering in
                    handleComposerButtonHover(
                        hovering,
                        state: $isStopHovered
                    )
                }
                .accessibilityLabel("Stop generation")
            } else {
                Button(action: { onAttach(); focusedComposerAction = nil }) {
                    Image(systemName: "paperclip")
                        .font(.system(size: composerActionIconSize, weight: .regular))
                        .foregroundColor(adaptiveColor(light: Forest._500, dark: Moss._400))
                }
                .buttonStyle(VIconButtonStyle(
                    isHovered: isAttachmentHovered,
                    isFocused: focusedComposerAction == .attachment,
                    size: composerActionButtonSize
                ))
                .focused($focusedComposerAction, equals: .attachment)
                .focusable(true)
                .onHover { hovering in
                    handleComposerButtonHover(
                        hovering,
                        state: $isAttachmentHovered,
                        isEnabled: hasAPIKey
                    )
                }
                .accessibilityLabel("Attach file")
                .disabled(!hasAPIKey)

                if canSend {
                    Button {
                        composerFocus = true
                        onSend()
                    } label: {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10)
                                .fill(VColor.sendButton)
                                .frame(width: 30, height: 30)
                            Image(systemName: "arrow.up")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                        }
                    }
                    .buttonStyle(VIconButtonStyle(
                        isHovered: isSendHovered,
                        isFocused: focusedComposerAction == .send,
                        size: composerActionButtonSize
                    ))
                    .focused($focusedComposerAction, equals: .send)
                    .focusable(true)
                    .onHover { hovering in
                        handleComposerButtonHover(
                            hovering,
                            state: $isSendHovered
                        )
                    }
                    .accessibilityLabel("Send message")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    MicrophoneButton(
                        isRecording: isRecording,
                        iconSize: composerActionIconSize,
                        action: { onMicrophoneToggle(); focusedComposerAction = nil }
                    )
                        .buttonStyle(VIconButtonStyle(
                            isHovered: isMicrophoneHovered,
                            isFocused: focusedComposerAction == .microphone,
                            size: composerActionButtonSize
                        ))
                        .focused($focusedComposerAction, equals: .microphone)
                        .focusable(true)
                        .onHover { hovering in
                            handleComposerButtonHover(
                                hovering,
                                state: $isMicrophoneHovered,
                                isEnabled: hasAPIKey
                            )
                        }
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
                Image(systemName: "waveform")
                    .font(.system(size: 14, weight: .medium))
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
                Button(action: { manager.toggleListening() }) {
                    Image(systemName: manager.state == .listening ? "mic.fill" : "mic.slash.fill")
                        .font(.system(size: composerActionIconSize, weight: .medium))
                        .foregroundColor(manager.state == .listening
                            ? adaptiveColor(light: Forest._500, dark: Moss._400)
                            : VColor.textSecondary)
                }
                .buttonStyle(VIconButtonStyle(
                    isHovered: false,
                    isFocused: false,
                    size: composerActionButtonSize
                ))
                .disabled(manager.state == .processing)
                .accessibilityLabel(manager.state == .listening ? "Mute" : "Unmute")

                // End voice mode (red X)
                Button(action: { onEndVoiceMode?() }) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(VColor.error)
                            .frame(width: 30, height: 30)
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.white)
                    }
                }
                .buttonStyle(VIconButtonStyle(
                    isHovered: false,
                    isFocused: false,
                    size: composerActionButtonSize
                ))
                .accessibilityLabel("End voice mode")
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

    private func handleComposerButtonHover(
        _ hovering: Bool,
        state: Binding<Bool>,
        isEnabled: Bool = true
    ) {
        let resolvedHover = isEnabled && hovering
        state.wrappedValue = resolvedHover
        #if os(macOS)
        if resolvedHover {
            NSCursor.pointingHand.set()
        } else {
            NSCursor.arrow.set()
        }
        #endif
    }

    var canSend: Bool {
        // Block send while an attachment is still loading: the user tapping Send
        // before the async load completes would drop the attachment from the message.
        hasAPIKey
            && !isLoadingAttachment
            && (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty)
    }

}

