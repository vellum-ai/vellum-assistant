import Combine
import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
import os
#if os(macOS)
import AppKit
#endif

private let composerLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "Composer")

struct ComposerView: View {
    private let composerMaxHeight: CGFloat = 200
    private let composerActionButtonSize: CGFloat = 34

    // MARK: - ComposerMode

    /// Three-mode state machine for the composer.
    private enum ComposerMode: Equatable {
        /// Normal text entry with attach/send buttons.
        case textEntry
        /// Inline dictation: text field visible with a recording strip below.
        case dictationInline
        /// Full voice conversation with inverse/high-contrast container.
        case voiceConversation
    }

    /// The current mode derived from recording and voice-mode state.
    private var currentMode: ComposerMode {
        if voiceModeManager.map({ $0.state != .off }) ?? false {
            return .voiceConversation
        } else if isRecording {
            return .dictationInline
        } else {
            return .textEntry
        }
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
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
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
    /// Snapshot of inputText captured when dictation starts, used to restore on cancel.
    @State private var preDictationText: String = ""
    /// Live amplitude from VoiceInputManager, bypassing ChatViewModel's 100ms coalescing.
    @State private var liveAmplitude: Float = 0

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

            // Composer box — switches on the three-mode state machine
            switch currentMode {
            case .voiceConversation:
                voiceConversationComposer

            case .dictationInline:
                dictationInlineComposer

            case .textEntry:
                textEntryComposer
            }
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
        .onChange(of: currentMode) {
            composerLog.debug("Composer mode: \(String(describing: currentMode))")
            if currentMode == .dictationInline {
                preDictationText = inputText
            }
        }
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
        // On macOS, the bridge consumes all Return variants that should insert
        // a newline (cmd-enter mode) or trigger a bridge-level send. The only
        // Return events that reach `.onSubmit` are plain Return in default mode,
        // which always means "send".
        performSendAction()
    }

    // MARK: - Text Entry Mode

    /// Standard composer shell with border, used for textEntry and dictationInline modes.
    @ViewBuilder
    private func standardComposerShell<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            if !pendingAttachments.isEmpty {
                attachmentStrip
            }
            content()
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

    @ViewBuilder
    private var textEntryComposer: some View {
        standardComposerShell {
            composerTextField
                .frame(minHeight: composerCompactHeight)
                .overlay(alignment: .bottomTrailing) {
                    composerActionButtons
                }
        }
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
                } else if inputText.isEmpty && !hasPendingConfirmation {
                    // Empty input: show dictate + voice mode buttons
                    VIconButton(
                        label: "Dictate",
                        icon: VIcon.mic.rawValue,
                        iconOnly: true,
                        size: composerActionButtonSize,
                        action: { (onDictateToggle ?? onMicrophoneToggle)() }
                    )
                    .disabled(!hasAPIKey)
                    .transition(.scale.combined(with: .opacity))

                    VoiceModeButton(size: composerActionButtonSize) {
                        onVoiceModeToggle?()
                    }
                    .disabled(!hasAPIKey)
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
        .animation(VAnimation.fast, value: canSend)
    }

    // MARK: - Dictation Inline Mode


    @ViewBuilder
    private var dictationInlineComposer: some View {
        standardComposerShell {
            VStack(spacing: VSpacing.sm) {
                // Text field remains visible for live transcription
                composerTextField
                    .frame(minHeight: composerCompactHeight)

                // Inline recording strip
                HStack(alignment: .center, spacing: VSpacing.sm) {
VStreamingWaveform(
                        amplitude: liveAmplitude,
                        isActive: true,
                        style: .scrolling,
                        foregroundColor: VColor.textMuted,
                        lineWidth: 2
                    )
                    .padding(.trailing, VSpacing.lg)
                    .frame(height: 44)
                    .frame(maxWidth: .infinity)

                    // Cancel: stop dictation and discard transcribed text
                    VIconButton(
                        label: "Cancel dictation",
                        icon: VIcon.x.rawValue,
                        iconOnly: true,
                        variant: .danger,
                        size: composerActionButtonSize,
                        action: {
                            inputText = preDictationText
                            preDictationText = ""
                            (onDictateToggle ?? onMicrophoneToggle)()
                        }
                    )

                    // Accept: stop dictation and keep transcribed text
                    VIconButton(
                        label: "Accept dictation",
                        icon: VIcon.check.rawValue,
                        iconOnly: true,
                        variant: .primary,
                        size: composerActionButtonSize,
                        action: {
                            preDictationText = ""
                            (onDictateToggle ?? onMicrophoneToggle)()
                        }
                    )
                }
            }
        }
        .onReceive(VoiceInputManager.amplitudeSubject.receive(on: RunLoop.main)) { amp in
            liveAmplitude = amp
        }
    }

    // MARK: - Voice Conversation Mode

    @ViewBuilder
    private var voiceConversationComposer: some View {
        if let manager = voiceModeManager {
            VStack(spacing: 0) {
                if !pendingAttachments.isEmpty {
                    attachmentStrip
                }

            HStack(spacing: VSpacing.sm) {
                // Scrolling waveform — full width, inverse color
                VStreamingWaveform(
                    amplitude: voiceConversationAmplitude(manager),
                    isActive: manager.state == .listening || manager.state == .speaking,
                    style: .scrolling,
                    foregroundColor: VColor.voiceComposerTextPrimary,
                    lineWidth: 2
                )
                .padding(.trailing, VSpacing.lg)
                .frame(height: 44)
                .frame(maxWidth: .infinity)

                // Right: mute/unmute + end button
                HStack(spacing: VSpacing.xs) {
                    VIconButton(
                        label: manager.state == .listening ? "Mute" : "Unmute",
                        icon: manager.state == .listening ? VIcon.mic.rawValue : VIcon.micOff.rawValue,
                        iconOnly: true,
                        variant: .neutral,
                        size: composerActionButtonSize,
                        action: { manager.toggleListening() }
                    )
                    .disabled(manager.state == .processing)

                    VIconButton(
                        label: "End voice mode",
                        icon: VIcon.phoneCall.rawValue,
                        iconOnly: true,
                        variant: .danger,
                        size: composerActionButtonSize,
                        action: { onEndVoiceMode?() }
                    )
                }
            }
            .padding(.vertical, VSpacing.md)
            .padding(.horizontal, VSpacing.lg)
            }
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.voiceComposerBackground)
            )
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        }
    }

    private func voiceConversationAmplitude(_ manager: VoiceModeManager) -> Float {
        let raw: Float
        switch manager.state {
        case .listening: raw = voiceService?.amplitude ?? 0
        case .speaking: raw = voiceService?.speakingAmplitude ?? 0
        default: raw = 0
        }
        // Amplify for more visible waveform spikes
        return min(raw * 2.5, 1.0)
    }

    private func voiceConversationWaveformColor(_ manager: VoiceModeManager) -> Color {
        switch manager.state {
        case .listening: return VColor.accent
        case .speaking: return VColor.success
        case .processing: return VColor.textSecondary
        default: return VColor.accent
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

// MARK: - Voice Mode Button

/// Circle button with inverse colors for voice mode entry.
private struct VoiceModeButton: View {
    let size: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VIconView(.audioWaveform, size: 13)
                .frame(width: 20, height: 20)
                .foregroundColor(VColor.voiceComposerTextPrimary)
        }
        .buttonStyle(.plain)
        .frame(width: size, height: size)
        .background(
            Circle()
                .fill(VColor.voiceComposerBackground)
                .frame(width: 28, height: 28)
        )
        .contentShape(Circle().size(width: size, height: size))
        .pointerCursor()
        .accessibilityLabel("Voice mode")
    }
}
