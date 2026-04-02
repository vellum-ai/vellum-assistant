import Combine
import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
import os
#if os(macOS)
import AppKit
#endif

private let composerLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "Composer")

struct ComposerView: View {
    private let composerMaxHeight: CGFloat = 300
    private let composerActionButtonSize: CGFloat = 32

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
    let isSending: Bool
    var isAssistantBusy: Bool = false
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
    let onMicrophoneToggle: () -> Void
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var placeholderText: String = "What would you like to do?"
    var composerCompactHeight: CGFloat = 38
    var conversationId: UUID?
    var isInteractionEnabled: Bool = true
    var contextWindowFillRatio: Double? = nil
    var contextWindowTokens: Int? = nil
    var contextWindowMaxTokens: Int? = nil

    @Environment(\.cmdEnterToSend) private var cmdEnterToSend
    #if os(macOS)
    @Environment(\.dropActions) private var dropActions
    #endif
    @State private var composerFocus: Bool = false
    @State private var isComposerFocused = false
    @State private var measuredTextHeight: CGFloat = 32
    @State private var textViewIsFocused: Bool = false
    @State var cursorPosition: Int = 0

    @State var showSlashMenu = false
    @State var slashFilter = ""
    @State var slashSelectedIndex = 0
    @State var suppressSlashReopen = false
    @State var showEmojiMenu = false
    @State var emojiFilter = ""
    @State var emojiSelectedIndex = 0
    @State var textReplacer = TextReplacementProxy()
    /// Snapshot of inputText captured when dictation starts, used to restore on cancel.
    @State private var preDictationText: String = ""
    /// Live amplitude from VoiceInputManager, bypassing ChatViewModel's 100ms coalescing.
    @State private var liveAmplitude: Float = 0

    /// The portion of the suggestion that extends beyond the current input.
    /// Hidden when the user has pending attachments so the composer looks empty
    /// and they aren't confused about what will be sent.
    private var ghostSuffix: String? {
        guard let suggestion, pendingAttachments.isEmpty else { return nil }
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

            if showEmojiMenu {
                EmojiPickerPopup(
                    entries: filteredEmoji(emojiFilter),
                    selectedIndex: emojiSelectedIndex,
                    onSelect: { entry in selectEmoji(entry) }
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
        #if os(macOS)
        .onDrop(of: [.fileURL, .image, .png, .tiff], isTargeted: dropActions.isDropTargeted) { providers in
            ComposerDropHandler.handleDrop(providers: providers, actions: dropActions)
        }
        #endif
        .fixedSize(horizontal: false, vertical: true)
        .animation(VAnimation.fast, value: showSlashMenu)
        .animation(VAnimation.fast, value: showEmojiMenu)
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, VSpacing.sm)
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity)
        .disabled(!isInteractionEnabled)
        .animation(VAnimation.fast, value: isComposerFocused)
        .task {
            // Delay focus slightly so the NSTextView is fully installed
            // in the view hierarchy before requesting first-responder
            // status. Setting @FocusState synchronously during an animated
            // layout pass (e.g. the empty-state fade-in) can give logical
            // focus without rendering the blinking caret.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            composerFocus = isInteractionEnabled
        }
        .task(id: conversationId) {
            guard isInteractionEnabled, !hasPendingConfirmation else { return }
            // Same delay: the conversation switch may trigger a view rebuild
            // (new empty state) whose layout isn't settled yet.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            composerFocus = true
        }
        .onChange(of: currentMode) {
            composerLog.debug("Composer mode: \(String(describing: currentMode))")
            if currentMode == .dictationInline {
                preDictationText = inputText
            }
        }
        .onChange(of: isInteractionEnabled) { _, enabled in
            if enabled, !hasPendingConfirmation {
                composerFocus = true
            } else if !enabled {
                composerFocus = false
                showSlashMenu = false
                showEmojiMenu = false
                suppressSlashReopen = false
            }
        }
        .onChange(of: hasPendingConfirmation) { _, pending in
            if !pending, isInteractionEnabled {
                composerFocus = true
            }
        }
    }

    /// Text overlays (slash highlighting, ghost text) rendered behind / on
    /// top of the text editor inside the ZStack. Separated into its own
    /// builder so the compiler can type-check the ZStack body in
    /// reasonable time.
    @ViewBuilder
    private func composerTextOverlays(font: Font, hasSlashHighlight: Bool) -> some View {
        // Slash command highlighting overlay — renders the full input
        // with the /command prefix in the accent color. The text editor
        // below is made transparent so this overlay provides the
        // visible text coloring.
        if hasSlashHighlight {
            Text(slashHighlightedText(font: font))
                .lineSpacing(4)
                .lineLimit(1...)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }

        // Ghost text overlay (invisible matching input + visible suffix)
        if let ghostSuffix {
            (Text(inputText)
                .font(font)
                .foregroundStyle(.clear)
            + Text(ghostSuffix)
                .font(font)
                .foregroundStyle(VColor.contentSecondary.opacity(0.55)))
                .lineSpacing(4)
                .lineLimit(2)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }


    private var composerTextField: some View {
        let scaledBody = VFont.chat
        let hasSlashHighlight = slashCommandRange != nil
        let nsFont = VFont.nsChat

        return ZStack(alignment: .topLeading) {
            composerTextOverlays(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
                .padding(.leading, ComposerTextEditor.textInsetX)
                .padding(.top, ComposerTextEditor.textInsetY)
            ComposerTextEditor(
                text: $inputText,
                measuredHeight: $measuredTextHeight,
                isFocused: $textViewIsFocused,
                font: nsFont,
                lineSpacing: 4,
                insertionPointColor: NSColor(VColor.primaryBase),
                minHeight: composerActionButtonSize,
                maxHeight: composerMaxHeight,
                placeholder: ghostSuffix == nil ? placeholderText : "",
                isEditable: isInteractionEnabled,
                cmdEnterToSend: cmdEnterToSend,
                textColorOverride: hasSlashHighlight
                    ? NSColor(VColor.contentDefault).withAlphaComponent(0) : nil,
                onSubmit: { performSendAction() },
                onTab: {
                    if showSlashMenu { handleSlashNavigation(.tab); return true }
                    if showEmojiMenu { handleEmojiNavigation(.tab); return true }
                    if ghostSuffix != nil { onAcceptSuggestion(); return true }
                    return false
                },
                onUpArrow: {
                    if showSlashMenu { handleSlashNavigation(.up); return true }
                    if showEmojiMenu { handleEmojiNavigation(.up); return true }
                    return false
                },
                onDownArrow: {
                    if showSlashMenu { handleSlashNavigation(.down); return true }
                    if showEmojiMenu { handleEmojiNavigation(.down); return true }
                    return false
                },
                onEscape: {
                    if showSlashMenu { handleSlashNavigation(.dismiss); return true }
                    if showEmojiMenu { handleEmojiNavigation(.dismiss); return true }
                    return false
                },
                onPasteImage: onPaste,
                cursorPosition: $cursorPosition,
                textReplacer: textReplacer
            )
            .fixedSize(horizontal: false, vertical: true)
            // Prevent inherited .animation() modifiers from creating animation
            // transactions that snapshot the NSView's CALayer. Without this,
            // parent animations (e.g. .animation(value: isComposerFocused)) can
            // freeze the text view's rendering, making typed text invisible.
            .transaction { $0.animation = nil }
        }
        .padding(.vertical, VSpacing.xs)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel("Message")
        .frame(maxWidth: .infinity)
        .background(
            ComposerFocusBridge(
                isFocused: composerFocus,
                isInteractionEnabled: isInteractionEnabled,
                onRedirectKeystroke: { chars in
                    inputText += chars
                    composerFocus = true
                }
            )
        )
        .onChange(of: composerFocus) {
            if textViewIsFocused != composerFocus {
                textViewIsFocused = composerFocus
            }
            isComposerFocused = composerFocus
            if composerFocus {
                if let window = NSApp.keyWindow as? TitleBarZoomableWindow {
                    window.clearComposerDismissed()
                }
            }
        }
        .onChange(of: textViewIsFocused) {
            if composerFocus != textViewIsFocused {
                composerFocus = textViewIsFocused
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
                withAnimation(VAnimation.fast) { showSlashMenu = false; showEmojiMenu = false }
            } else {
                updateSlashState()
                updateEmojiState()
            }
        }
        .onChange(of: cursorPosition) {
            if !inputText.isEmpty {
                updateEmojiState()
            }
        }
    }

    /// Shared send logic invoked by the composer's submit callback.
    /// Handles slash-menu selection and pending-confirmation approval
    /// regardless of how "send" is triggered.
    private func performSendAction() {
        let sendPath: String
        if showSlashMenu {
            sendPath = "slashSelection"
            handleSlashNavigation(.select)
        } else if showEmojiMenu {
            sendPath = "emojiSelection"
            handleEmojiNavigation(.select)
        } else if canSend {
            sendPath = "normalSend"
            onSend()
            SoundManager.shared.play(.messageSent)
        } else if hasPendingConfirmation
                    && inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            sendPath = "pendingConfirmationApproval"
            onAllowPendingConfirmation?()
        } else {
            sendPath = "noAction"
        }

        composerLog.debug("[Send] path=\(sendPath) attachmentCount=\(pendingAttachments.count) isLoadingAttachment=\(isLoadingAttachment)")
    }

    // MARK: - Text Entry Mode

    /// Standard composer shell with border, used for textEntry and dictationInline modes.
    @ViewBuilder
    private func standardComposerShell<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            if !pendingAttachments.isEmpty || isLoadingAttachment {
                attachmentStrip
            }
            content()
        }
        .padding(.vertical, VSpacing.sm)
        .padding(.horizontal, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.window)
                .fill(VColor.surfaceOverlay)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.window))
        .shadow(color: VColor.auxBlack.opacity(0.05), radius: 2, x: 0, y: 2)
    }

    @ViewBuilder
    private var textEntryComposer: some View {
        standardComposerShell {
            VStack(spacing: 0) {
                composerTextField
                    .padding(.leading, VSpacing.xs)
                    .frame(minHeight: composerActionButtonSize)
                composerActionBar
            }
        }
    }

    /// Bottom action bar: paperclip on the left, send/mic/stop on the right.
    @ViewBuilder
    private var composerActionBar: some View {
        HStack(spacing: VSpacing.xs) {
            // Left side
            if !isAssistantBusy || hasPendingConfirmation {
                VButton(
                    label: "Attach file",
                    iconOnly: VIcon.paperclip.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { onAttach() }
                )

                .vTooltip("Attach file")
            }

            VContextWindowIndicator(
                fillRatio: contextWindowFillRatio,
                tokensUsed: contextWindowTokens,
                tokensMax: contextWindowMaxTokens
            )

            Spacer()

            // Right side
            if isAssistantBusy && !hasPendingConfirmation {
                VButton(
                    label: "Stop generation",
                    iconOnly: VIcon.square.rawValue,
                    style: .contrast,
                    iconSize: composerActionButtonSize,
                    action: onStop
                )
            } else if inputText.isEmpty && !hasPendingConfirmation {
                if onVoiceModeToggle != nil {
                    // Live voice button
                    VButton(
                        label: "Voice mode",
                        iconOnly: VIcon.audioWaveform.rawValue,
                        style: .ghost,
                        iconSize: composerActionButtonSize,
                        action: { onVoiceModeToggle?() }
                    )
                    .vTooltip("Live voice conversation")
                }

                // Dictate button
                VButton(
                    label: "Dictate",
                    iconOnly: VIcon.mic.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { (onDictateToggle ?? onMicrophoneToggle)() }
                )

                .vTooltip(micTooltipText)

                // Send button (always visible, disabled when empty)
                VButton(
                    label: "Send message",
                    iconOnly: VIcon.arrowUp.rawValue,
                    style: .primary,
                    isDisabled: !canSend,
                    iconSize: composerActionButtonSize
                ) {
                    composerFocus = true
                    performSendAction()
                }
                .vTooltip("Type a message to send")
            } else if !hasPendingConfirmation {
                // Mic button (visible with or without text)
                VButton(
                    label: isRecording ? "Stop recording" : "Dictate",
                    iconOnly: VIcon.mic.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { (onDictateToggle ?? onMicrophoneToggle)() }
                )

                .vTooltip(micTooltipText)

                // Send button
                VButton(
                    label: "Send message",
                    iconOnly: VIcon.arrowUp.rawValue,
                    style: .primary,
                    isDisabled: !canSend,
                    iconSize: composerActionButtonSize
                ) {
                    composerFocus = true
                    performSendAction()
                }
                .vTooltip(canSend ? "Send" : "Type a message to send")
            } else {
                // Pending confirmation — show same buttons as empty-input state
                if onVoiceModeToggle != nil {
                    VButton(
                        label: "Voice mode",
                        iconOnly: VIcon.audioWaveform.rawValue,
                        style: .ghost,
                        iconSize: composerActionButtonSize,
                        action: { onVoiceModeToggle?() }
                    )
                }

                VButton(
                    label: isRecording ? "Stop recording" : "Dictate",
                    iconOnly: VIcon.mic.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { (onDictateToggle ?? onMicrophoneToggle)() }
                )


                VButton(
                    label: "Send message",
                    iconOnly: VIcon.arrowUp.rawValue,
                    style: .primary,
                    isDisabled: !canSend,
                    iconSize: composerActionButtonSize
                ) {
                    composerFocus = true
                    performSendAction()
                }
            }
        }
    }

    // MARK: - Dictation Inline Mode


    @ViewBuilder
    private var dictationInlineComposer: some View {
        standardComposerShell {
            VStack(spacing: VSpacing.sm) {
                // Text field remains visible for live transcription
                composerTextField
                    .frame(minHeight: composerActionButtonSize)

                // Inline recording strip
                HStack(alignment: .center, spacing: VSpacing.sm) {
VStreamingWaveform(
                        amplitude: liveAmplitude,
                        isActive: true,
                        style: .scrolling,
                        foregroundColor: VColor.contentTertiary,
                        lineWidth: 2
                    )
                    .padding(.trailing, VSpacing.lg)
                    .frame(height: 44)
                    .frame(maxWidth: .infinity)

                    // Cancel: stop dictation and discard transcribed text
                    VButton(
                        label: "Cancel dictation",
                        iconOnly: VIcon.x.rawValue,
                        style: .danger,
                        iconSize: composerActionButtonSize,
                        action: {
                            inputText = preDictationText
                            preDictationText = ""
                            (onDictateToggle ?? onMicrophoneToggle)()
                        }
                    )
                    .vTooltip("Cancel")

                    // Accept: stop dictation and keep transcribed text
                    VButton(
                        label: "Accept dictation",
                        iconOnly: VIcon.check.rawValue,
                        style: .primary,
                        iconSize: composerActionButtonSize,
                        action: {
                            preDictationText = ""
                            (onDictateToggle ?? onMicrophoneToggle)()
                        }
                    )
                    .vTooltip("Done")
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
                if !pendingAttachments.isEmpty || isLoadingAttachment {
                    attachmentStrip
                }

            HStack(spacing: VSpacing.sm) {
                // Scrolling waveform — full width, inverse color
                VStreamingWaveform(
                    amplitude: voiceConversationAmplitude(manager),
                    isActive: manager.state == .listening || manager.state == .speaking,
                    style: .scrolling,
                    foregroundColor: VColor.contentInset,
                    lineWidth: 2
                )
                .padding(.trailing, VSpacing.lg)
                .frame(height: 44)
                .frame(maxWidth: .infinity)

                // Right: mute/unmute + end button
                HStack(spacing: VSpacing.xs) {
                    VButton(
                        label: manager.state == .listening ? "Mute" : "Unmute",
                        iconOnly: manager.state == .listening ? VIcon.mic.rawValue : VIcon.micOff.rawValue,
                        style: .contrast,
                        iconSize: composerActionButtonSize,
                        action: { manager.toggleListening() }
                    )
                    .disabled(manager.state == .processing)
                    .vTooltip(manager.state == .listening ? "Mute" : "Unmute")

                    VButton(
                        label: "End voice mode",
                        iconOnly: VIcon.x.rawValue,
                        style: .danger,
                        iconSize: composerActionButtonSize,
                        action: { onEndVoiceMode?() }
                    )
                    .vTooltip("Cancel Live Voice")
                }
            }
            .padding(.vertical, VSpacing.md)
            .padding(.horizontal, VSpacing.lg)
            }
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.contentEmphasized)
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
        case .listening: return VColor.primaryBase
        case .speaking: return VColor.systemPositiveStrong
        case .processing: return VColor.contentSecondary
        default: return VColor.primaryBase
        }
    }

    /// Tooltip text for the mic button. Includes the PTT hold hint only when PTT is enabled.
    private var micTooltipText: String {
        let activator = PTTActivator.cached
        if activator.kind == .none {
            return "Click to dictate"
        }
        return "Click to dictate or hold \(activator.displayName)"
    }

    var canSend: Bool {
        // Block send while an attachment is still loading: the user tapping Send
        // before the async load completes would drop the attachment from the message.
        !isLoadingAttachment
            && (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty)
    }

}

