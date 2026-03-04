import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

private struct CmdEnterToSendKey: EnvironmentKey {
    static let defaultValue: Bool = false
}

extension EnvironmentValues {
    var cmdEnterToSend: Bool {
        get { self[CmdEnterToSendKey.self] }
        set { self[CmdEnterToSendKey.self] = newValue }
    }
}

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
                    // In compact mode, text field and buttons share a row;
                    // in expanded mode, buttons sit on a separate row below.
                    HStack(alignment: .center, spacing: VSpacing.md) {
                        composerTextField
                        if !isComposerExpanded {
                            composerActionButtons
                                .frame(maxHeight: .infinity, alignment: .center)
                                .offset(y: compactActionOpticalYOffset)
                        }
                    }
                    .frame(minHeight: composerCompactHeight)

                    if isComposerExpanded {
                        // Expanded: buttons on a separate row below the text area
                        HStack(spacing: VSpacing.md) {
                            Spacer()
                            composerActionButtons
                        }
                        .padding(.top, VSpacing.xs)
                    }
                }
            }
            .padding(.top, isComposerExpanded ? VSpacing.md : VSpacing.sm)
            .padding(.bottom, isComposerExpanded ? VSpacing.sm : VSpacing.sm)
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

    /// How far above the composer's top edge the slash popup should float.
    /// Uses a small gap so the popup sits just above the composer box.
    private var slashPopupOffset: CGFloat {
        VSpacing.md
    }

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
                .lineLimit(1...6)
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
                .lineLimit(1...6)
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
        .lineLimit(1...6)
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

        return ZStack(alignment: .leading) {
            composerTextOverlays(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
            composerInputField(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
        }
        .accessibilityLabel("Message")
        .frame(maxWidth: .infinity, alignment: .leading)
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
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            let group = DispatchGroup()
            // Collect URLs on the main queue to avoid concurrent Array mutation
            // from loadObject callbacks that may fire on different threads.
            var urls: [URL] = []
            for provider in providers {
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    DispatchQueue.main.async {
                        if let url { urls.append(url) }
                        group.leave()
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
    private func handleReturnKeyPress(modifiers: EventModifiers) -> KeyPress.Result {
        // Shift+Enter always inserts a newline
        if modifiers.contains(.shift) { return .ignored }

        if cmdEnterToSend {
            // In Cmd+Enter mode: Cmd+Enter sends, plain Enter inserts newline.
            // Cmd+Enter as a key equivalent is handled by ComposerFocusBridge's
            // event monitor; if it also reaches here, handle it.
            if modifiers.contains(.command) {
                performSendAction()
                return .handled
            }
            return .ignored // plain Enter inserts newline
        }

        // Default mode: plain Enter sends, any modifier combo is ignored
        if !modifiers.isEmpty { return .ignored }
        performSendAction()
        return .handled
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

    // MARK: - Attachment Preview Strip

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.sm) {
                ForEach(pendingAttachments) { attachment in
                    attachmentChip(attachment)
                }
            }
            .padding(.top, VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
        }
    }

    private func attachmentChip(_ attachment: ChatAttachment) -> some View {
        let fileSize = formattedFileSize(base64Length: attachment.dataLength)
        let isImage = attachment.mimeType.hasPrefix("image/")

        return HStack(spacing: VSpacing.sm) {
            if isImage, let nsImage = attachment.thumbnailImage {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            } else {
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(VColor.surfaceBorder.opacity(0.5))
                    .frame(width: 28, height: 28)
                    .overlay {
                        Image(systemName: iconForMimeType(attachment.mimeType, filename: attachment.filename))
                            .font(.system(size: 14))
                            .foregroundColor(VColor.textSecondary)
                    }
            }

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)

            Text("· \(fileSize)")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            Button {
                onRemoveAttachment(attachment.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(.vertical, VSpacing.xs)
        .padding(.horizontal, VSpacing.sm)
        .background(VColor.surfaceBorder.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .frame(maxWidth: 280)
    }

    // MARK: - Helpers

    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 {
            return "\(bytes) B"
        } else if bytes < 1024 * 1024 {
            return "\(bytes / 1024) KB"
        } else {
            let mb = Double(bytes) / (1024 * 1024)
            return String(format: "%.1f MB", mb)
        }
    }

    private func fileExtension(_ filename: String) -> String {
        let parts = filename.split(separator: ".")
        guard parts.count > 1, let last = parts.last else { return "" }
        return String(last).uppercased()
    }

    private func iconForMimeType(_ mimeType: String, filename: String) -> String {
        if mimeType == "application/pdf" { return "doc.fill" }
        if mimeType.hasPrefix("text/") { return "doc.text.fill" }
        if mimeType.hasPrefix("image/") { return "photo" }
        let ext = filename.split(separator: ".").last.map(String.init) ?? ""
        switch ext.lowercased() {
        case "pdf": return "doc.fill"
        case "csv": return "tablecells"
        case "md", "txt": return "doc.text.fill"
        default: return "doc.fill"
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

// MARK: - Composer Editor Height Preference Key

/// PreferenceKey used to measure the natural height of the TextField composer
/// so that ChatView can compute the correct bottom safe-area inset.
private struct ComposerEditorHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Composer Focus Bridge

/// Minimal NSViewRepresentable that provides AppKit integration for the
/// SwiftUI TextField composer:
/// - Registers a typing-redirect handler with TitleBarZoomableWindow so
///   keystrokes auto-focus the composer when nothing else is focused.
/// - Registers the composer container view for click-away-to-blur detection.
/// - Intercepts Cmd+V when the pasteboard contains image content.
/// - Intercepts Cmd+Enter for send when cmdEnterToSend is enabled.
private struct ComposerFocusBridge: NSViewRepresentable {
    let isFocused: Bool
    let cmdEnterToSend: Bool
    let onImagePaste: () -> Void
    let onCmdEnterSend: () -> Void
    let onRedirectKeystroke: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        context.coordinator.setupEventMonitor()
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.parent = self

        guard let window = nsView.window as? TitleBarZoomableWindow else { return }

        // Register a typing-redirect handler so keystrokes auto-focus the composer.
        let coordinator = context.coordinator
        window.composerRedirectHandler = { chars in
            coordinator.parent.onRedirectKeystroke(chars)
        }

        // Walk up from the bridge view to find the composer container —
        // the first ancestor whose frame is wider, encompassing the sibling
        // action buttons. Re-evaluated on each update because layout can
        // change (compact vs expanded).
        var container: NSView = nsView
        var candidate = nsView.superview
        while let view = candidate, view !== window.contentView {
            if view.frame.width > nsView.frame.width + 20 {
                container = view
                break
            }
            candidate = view.superview
        }
        window.composerContainerView = container
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.removeEventMonitor()
        if let window = nsView.window as? TitleBarZoomableWindow {
            window.composerRedirectHandler = nil
        }
    }

    final class Coordinator {
        var parent: ComposerFocusBridge
        var eventMonitor: Any?

        init(parent: ComposerFocusBridge) {
            self.parent = parent
        }

        func setupEventMonitor() {
            eventMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.parent.isFocused else { return event }

                let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])

                // Cmd+V with image content → intercept paste
                if modifiers == [.command],
                   event.charactersIgnoringModifiers?.lowercased() == "v",
                   Self.pasteboardHasImageContent() {
                    self.parent.onImagePaste()
                    return nil
                }

                // Cmd+Enter → send (when cmdEnterToSend is enabled)
                if self.parent.cmdEnterToSend,
                   modifiers == [.command],
                   event.keyCode == 36 || event.keyCode == 76 {
                    self.parent.onCmdEnterSend()
                    return nil
                }

                // Let zoom shortcuts propagate instead of being consumed
                if modifiers == [.command] || modifiers == [.command, .option] {
                    let key = event.charactersIgnoringModifiers ?? ""
                    if key == "=" || key == "+" || key == "-" || key == "0" {
                        return event
                    }
                }

                return event
            }
        }

        func removeEventMonitor() {
            if let monitor = eventMonitor {
                NSEvent.removeMonitor(monitor)
                eventMonitor = nil
            }
        }

        static func pasteboardHasImageContent() -> Bool {
            let pasteboard = NSPasteboard.general
            let hasImageFile = (pasteboard.readObjects(forClasses: [NSURL.self], options: [
                .urlReadingFileURLsOnly: true,
            ]) as? [URL])?.contains { url in
                let ext = url.pathExtension.lowercased()
                return ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "bmp"].contains(ext)
            } ?? false
            let hasImageData = pasteboard.data(forType: .png) != nil || pasteboard.data(forType: .tiff) != nil
            return hasImageFile || hasImageData
        }
    }
}

// MARK: - Microphone Button

private struct MicrophoneButton: View {
    let isRecording: Bool
    let iconSize: CGFloat
    let action: () -> Void
    @State private var isPulsing = false

    var body: some View {
        Button(action: action) {
            ZStack {
                if isRecording {
                    Circle()
                        .fill(VColor.error.opacity(0.2))
                        .frame(width: 30, height: 30)
                        .scaleEffect(isPulsing ? 1.3 : 1.0)
                        .opacity(isPulsing ? 0.0 : 1.0)
                        .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: false), value: isPulsing)
                }

                Image(systemName: isRecording ? "mic.fill" : "mic")
                    .font(.system(size: iconSize, weight: .regular))
                    .foregroundColor(isRecording ? VColor.error : adaptiveColor(light: Forest._500, dark: Moss._400))
            }
        }
        .accessibilityLabel(isRecording ? "Stop recording" : "Start voice input")
        .onChange(of: isRecording) {
            isPulsing = isRecording
        }
        .onAppear {
            isPulsing = isRecording
        }
    }
}

