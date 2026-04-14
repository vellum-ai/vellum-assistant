import Combine
import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared
import os
#if os(macOS)
import AppKit
#endif

private let composerLog = Logger(subsystem: Bundle.appBundleIdentifier, category: "Composer")

struct ComposerView: View, Equatable {
    static func == (lhs: ComposerView, rhs: ComposerView) -> Bool {
        // VoiceModeManager is @MainActor ObservableObject, not @Observable,
        // so SwiftUI cannot track its internal state changes via struct ==.
        // voiceModeState is a snapshot captured at struct-creation time so
        // lhs holds the previous state and rhs holds the current state,
        // avoiding live reads from a shared mutable reference.
        if lhs.voiceModeState != .off || rhs.voiceModeState != .off {
            return false
        }

        return lhs.inputText == rhs.inputText
            && lhs.isSending == rhs.isSending
            && lhs.isAssistantBusy == rhs.isAssistantBusy
            && lhs.hasPendingConfirmation == rhs.hasPendingConfirmation
            && lhs.isRecording == rhs.isRecording
            && lhs.suggestion == rhs.suggestion
            && lhs.pendingAttachments.map(\.id) == rhs.pendingAttachments.map(\.id)
            && lhs.isLoadingAttachment == rhs.isLoadingAttachment
            && lhs.recordingAmplitude == rhs.recordingAmplitude
            && lhs.placeholderText == rhs.placeholderText
            && lhs.composerCompactHeight == rhs.composerCompactHeight
            && lhs.conversationId == rhs.conversationId
            && lhs.isInteractionEnabled == rhs.isInteractionEnabled
            && lhs.contextWindowFillRatio == rhs.contextWindowFillRatio
            && lhs.contextWindowTokens == rhs.contextWindowTokens
            && lhs.contextWindowMaxTokens == rhs.contextWindowMaxTokens
            // Optional closure availability — nil vs non-nil affects which
            // buttons are rendered (e.g. voice toggle, dictation routing).
            && (lhs.onAllowPendingConfirmation != nil) == (rhs.onAllowPendingConfirmation != nil)
            && (lhs.onEndVoiceMode != nil) == (rhs.onEndVoiceMode != nil)
            && (lhs.onDictateToggle != nil) == (rhs.onDictateToggle != nil)
            && (lhs.onVoiceModeToggle != nil) == (rhs.onVoiceModeToggle != nil)
            // ConversationHostAccessControlConfiguration contains a closure
            // so it can't be Equatable; compare nil/non-nil plus the
            // value-type fields that drive rendering.
            && lhs.conversationHostAccessControl?.isEnabled == rhs.conversationHostAccessControl?.isEnabled
            && lhs.conversationHostAccessControl?.canToggle == rhs.conversationHostAccessControl?.canToggle
            && lhs.conversationHostAccessControl?.isUpdating == rhs.conversationHostAccessControl?.isUpdating
            && lhs.conversationHostAccessControl?.subtitle == rhs.conversationHostAccessControl?.subtitle
            && lhs.conversationHostAccessControl?.errorMessage == rhs.conversationHostAccessControl?.errorMessage
    }
    private let composerMaxHeight: CGFloat = 300
    private let composerActionButtonSize: CGFloat = 32

    // MARK: - ComposerMode

    /// Two-mode state machine for the composer.
    private enum ComposerMode: Equatable {
        /// Normal text entry with attach/send buttons.
        case textEntry
        /// Full voice conversation with inverse/high-contrast container.
        case voiceConversation
    }

    /// The current mode derived from voice-mode state.
    private var currentMode: ComposerMode {
        if voiceModeManager.map({ $0.state != .off }) ?? false {
            return .voiceConversation
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
    var voiceModeState: VoiceModeManager.State = .off
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
    var conversationHostAccessControl: ConversationHostAccessControlConfiguration? = nil

    @Environment(\.cmdEnterToSend) private var cmdEnterToSend
    #if os(macOS)
    @Environment(\.dropActions) private var dropActions
    #endif
    @State private var composerFocus: Bool = false
    @State private var isComposerFocused = false
    @State private var textViewIsFocused: Bool = false

    @State var textReplacer = TextReplacementProxy()
    @State var composerController = ComposerController()
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
            if composerController.showSlashMenu {
                SlashCommandPopup(
                    commands: composerController.slashCommandProvider.filteredCommands(composerController.slashFilter),
                    selectedIndex: composerController.slashSelectedIndex,
                    onSelect: { command in selectSlashCommand(command) }
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if composerController.showEmojiMenu {
                EmojiPickerPopup(
                    entries: composerController.emojiSearchProvider.search(query: composerController.emojiFilter, limit: 8),
                    selectedIndex: composerController.emojiSelectedIndex,
                    onSelect: { entry in selectEmoji(entry) }
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // Composer box — switches on the two-mode state machine
            switch currentMode {
            case .voiceConversation:
                voiceConversationComposer

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
        .padding(.horizontal, VSpacing.lg)
        .padding(.top, VSpacing.sm)
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
        }
        .onChange(of: isInteractionEnabled) { _, enabled in
            composerController.interactionEnabledChanged(enabled, hasPendingConfirmation: hasPendingConfirmation)
            composerFocus = composerController.focusIntent
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
        } else if inputText.isEmpty, !placeholderText.isEmpty {
            Text(placeholderText)
                .font(font)
                .foregroundStyle(Color(nsColor: .placeholderTextColor))
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
                isFocused: $textViewIsFocused,
                font: nsFont,
                lineSpacing: 4,
                insertionPointColor: NSColor(VColor.primaryBase),
                minHeight: composerActionButtonSize,
                maxHeight: composerMaxHeight,
                isEditable: isInteractionEnabled,
                cmdEnterToSend: cmdEnterToSend,
                textColorOverride: hasSlashHighlight
                    ? NSColor(VColor.contentDefault).withAlphaComponent(0) : nil,
                onSubmit: { performSendAction() },
                onTab: {
                    if composerController.showSlashMenu {
                        if let command = composerController.handleSlashNavigation(.tab) {
                            inputText = command.selectedInputText
                        }
                        return true
                    }
                    if composerController.showEmojiMenu {
                        if let entry = composerController.handleEmojiNavigation(.tab) {
                            selectEmoji(entry)
                        }
                        return true
                    }
                    if ghostSuffix != nil { onAcceptSuggestion(); return true }
                    return false
                },
                onUpArrow: {
                    if composerController.showSlashMenu { composerController.handleSlashNavigation(.up); return true }
                    if composerController.showEmojiMenu { composerController.handleEmojiNavigation(.up); return true }
                    return false
                },
                onDownArrow: {
                    if composerController.showSlashMenu { composerController.handleSlashNavigation(.down); return true }
                    if composerController.showEmojiMenu { composerController.handleEmojiNavigation(.down); return true }
                    return false
                },
                onEscape: {
                    if composerController.showSlashMenu {
                        composerController.handleSlashNavigation(.dismiss)
                        inputText = ""
                        return true
                    }
                    if composerController.showEmojiMenu { composerController.handleEmojiNavigation(.dismiss); return true }
                    return false
                },
                onPasteImage: onPaste,
                shouldOverrideReturn: {
                    composerController.isPopupVisible
                },
                onCursorPositionChanged: { composerController.cursorMoved(to: $0) },
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
            composerController.textChanged(inputText)
        }
    }

    /// Shared send logic invoked by the composer's submit callback.
    /// Handles slash-menu selection and pending-confirmation approval
    /// regardless of how "send" is triggered.
    private func performSendAction() {
        let sendPath: String
        if composerController.showSlashMenu {
            sendPath = "slashSelection"
            if let command = composerController.handleSlashNavigation(.select) {
                selectSlashCommand(command)
            }
        } else if composerController.showEmojiMenu {
            sendPath = "emojiSelection"
            if let entry = composerController.handleEmojiNavigation(.select) {
                selectEmoji(entry)
            }
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

    /// Standard composer shell with border, used for textEntry mode.
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
                .fill(VColor.surfaceLift)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.window))
        .shadow(color: VColor.auxBlack.opacity(0.05), radius: 4, x: 0, y: 2)
    }

    @ViewBuilder
    private var textEntryComposer: some View {
        standardComposerShell {
            VStack(spacing: 0) {
                composerTextField
                    .padding(.leading, VSpacing.xs)
                    .frame(minHeight: composerActionButtonSize)

                if isRecording {
                    VStreamingWaveform(
                        amplitude: liveAmplitude,
                        isActive: true,
                        style: .scrolling,
                        foregroundColor: VColor.contentTertiary,
                        lineWidth: 2
                    )
                    .frame(height: 32)
                    .frame(maxWidth: .infinity)
                }

                composerActionBar
            }
        }
        .onReceive(VoiceInputManager.amplitudeSubject.receive(on: RunLoop.main)) { amp in
            liveAmplitude = amp
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

            if let hostAccess = conversationHostAccessControl {
                Button(action: hostAccess.onToggle) {
                    VIconView(hostAccess.isEnabled ? .terminal : .lock, size: 14)
                        .foregroundStyle(
                            hostAccess.isEnabled
                                ? VColor.systemPositiveStrong
                                : VColor.contentSecondary
                        )
                        .frame(width: composerActionButtonSize, height: composerActionButtonSize)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!hostAccess.canToggle || hostAccess.isUpdating)
                .vTooltip(hostAccess.errorMessage ?? "Computer access — \(hostAccess.subtitle)")
                .accessibilityLabel("Computer access")
                .accessibilityValue(hostAccess.isEnabled ? "Enabled" : "Disabled")
                .animation(.easeInOut(duration: 0.15), value: hostAccess.isEnabled)
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
                    style: .primary,
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

                // Dictate / stop button
                VButton(
                    label: isRecording ? "Stop recording" : "Dictate",
                    iconOnly: isRecording ? VIcon.circleStop.rawValue : VIcon.mic.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { (onDictateToggle ?? onMicrophoneToggle)() }
                )
                .vTooltip(isRecording ? "Stop recording" : micTooltipText)

                if !isRecording {
                    // Send button (hidden during recording)
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
                }
            } else if !hasPendingConfirmation {
                // Mic / stop button
                VButton(
                    label: isRecording ? "Stop recording" : "Dictate",
                    iconOnly: isRecording ? VIcon.circleStop.rawValue : VIcon.mic.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { (onDictateToggle ?? onMicrophoneToggle)() }
                )
                .vTooltip(isRecording ? "Stop recording" : micTooltipText)

                if !isRecording {
                    // Send button (hidden during recording)
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
                }
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
                    .vTooltip("Live voice conversation")
                }

                VButton(
                    label: isRecording ? "Stop recording" : "Dictate",
                    iconOnly: isRecording ? VIcon.circleStop.rawValue : VIcon.mic.rawValue,
                    style: .ghost,
                    iconSize: composerActionButtonSize,
                    action: { (onDictateToggle ?? onMicrophoneToggle)() }
                )
                .vTooltip(isRecording ? "Stop recording" : micTooltipText)

                if !isRecording {
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
                }
            }
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
                        style: .primary,
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
