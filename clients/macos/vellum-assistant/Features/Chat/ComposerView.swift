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

    @Environment(\.cmdEnterToSend) private var cmdEnterToSend
    @FocusState private var composerFocus: Bool
    @State private var isComposerFocused = false
    /// Incremented when inputText is cleared externally (e.g. after send) to force
    /// the TextField to rebuild, clearing its stale field editor buffer.
    @State private var composerResetId = 0

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
        .disabled(!isInteractionEnabled)
        .animation(VAnimation.fast, value: isComposerFocused)
        .onAppear {
            let identity = IdentityInfo.load()
            avatarSeed = identity?.name ?? "default"
        }
        .task {
            // Delay focus slightly so the NSTextView field editor is fully
            // installed before we request first-responder status. Setting
            // @FocusState synchronously during an animated layout pass
            // (e.g. the empty-state fade-in) can give logical focus without
            // rendering the blinking caret.
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
                suppressSlashReopen = false
            }
        }
        .onChange(of: hasPendingConfirmation) { _, pending in
            if !pending, isInteractionEnabled {
                composerFocus = true
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
        .lineSpacing(4)
        .foregroundStyle(hasSlashHighlight ? .clear : VColor.contentDefault)
        .tint(VColor.primaryBase)
        .id(composerResetId)
        .focused($composerFocus)
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
        let scaledBody = VFont.bodyMediumLighter
        let hasSlashHighlight = slashCommandRange != nil

        return ScrollView(.vertical, showsIndicators: false) {
            ZStack(alignment: .topLeading) {
                composerTextOverlays(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
                composerInputField(font: scaledBody, hasSlashHighlight: hasSlashHighlight)
            }
            .padding(.vertical, VSpacing.xs)
            .frame(maxWidth: .infinity, minHeight: composerActionButtonSize, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(.bottom)
        .frame(minHeight: composerActionButtonSize, maxHeight: inputText.isEmpty && ghostSuffix == nil ? composerActionButtonSize : composerMaxHeight)
        .accessibilityLabel("Message")
        .frame(maxWidth: .infinity)
        .background(
            ComposerFocusBridge(
                isFocused: composerFocus,
                cmdEnterToSend: cmdEnterToSend,
                isInteractionEnabled: isInteractionEnabled,
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
                // Force TextField rebuild to clear its stale field editor buffer.
                // On macOS, TextField(axis: .vertical) can desync when the binding
                // is cleared externally — the field editor writes stale text back.
                composerResetId += 1
                DispatchQueue.main.async {
                    composerFocus = true
                }
            } else {
                updateSlashState()
            }
        }
    }

    /// Shared send logic used by `.onSubmit` (native Return-to-send) and the
    /// AppKit `ComposerFocusBridge` Cmd+Enter interception. Keeps slash-menu
    /// selection and pending-confirmation approval working regardless of how
    /// "send" is triggered.
    private func performSendAction() {
        let sendPath: String
        if showSlashMenu {
            sendPath = "slashSelection"
            handleSlashNavigation(.select)
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
            if isSending && !hasPendingConfirmation {
                Spacer()
            } else {
                VButton(
                    label: "Attach file",
                    iconOnly: VIcon.paperclip.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { onAttach() }
                )

                .vTooltip("Attach file")

                Spacer()
            }

            // Right side
            if isSending && !hasPendingConfirmation {
                VButton(
                    label: "Stop generation",
                    iconOnly: VIcon.square.rawValue,
                    style: .contrast,
                    iconSize: composerActionButtonSize,
                    action: onStop
                )
            } else if inputText.isEmpty && !hasPendingConfirmation {
                // Live voice button
                VButton(
                    label: "Voice mode",
                    iconOnly: VIcon.audioWaveform.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { onVoiceModeToggle?() }
                )

                .vTooltip("Live voice conversation")

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
                VButton(
                    label: "Voice mode",
                    iconOnly: VIcon.audioWaveform.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { onVoiceModeToggle?() }
                )


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
        let activator = PTTActivator.fromStored()
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

