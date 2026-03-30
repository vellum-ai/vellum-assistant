import Observation
import SwiftUI
import VellumAssistantShared

// MARK: - Hover State

/// Lightweight @Observable class that isolates hover state from ChatBubble's body.
///
/// ChatBubble owns this via @State but never reads `isHovered` in its body —
/// only ChatBubbleOverflowMenu reads it. Per the Observation framework, only
/// views that access a tracked property are invalidated when it changes. This
/// means hover enter/exit on the bubble does NOT trigger a ChatBubble.body
/// re-evaluation; only the small overflow menu is re-evaluated (an opacity toggle).
///
/// References:
/// - [WWDC23 — Discover Observation in SwiftUI](https://developer.apple.com/videos/play/wwdc2023/10149/)
/// - [Apple: Understanding and improving SwiftUI performance](https://developer.apple.com/documentation/Xcode/understanding-and-improving-swiftui-performance)
@MainActor @Observable
final class ChatBubbleHoverState {
    var isHovered = false
}

// MARK: - Overflow Menu

/// Extracted from ChatBubble to isolate volatile @State properties (copy confirmation,
/// TTS audio, popover state) from the monolithic 800+ line parent view.
///
/// When any of these states change (hover, copy feedback, audio playback), only this
/// small view's body is re-evaluated — not the entire ChatBubble with its expensive
/// markdown rendering, interleaved content, and media embeds.
///
/// References:
/// - [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
///   "Move @State to the narrowest view that needs it"
struct ChatBubbleOverflowMenu: View {
    let message: ChatMessage
    let hoverState: ChatBubbleHoverState
    let isTTSEnabled: Bool
    let showInspectButton: Bool
    var onForkFromMessage: ((String) -> Void)?
    var onInspectMessage: ((String?) -> Void)?

    @State private var audioPlayer = MessageAudioPlayer()
    @State private var showCopyConfirmation = false
    @State private var showTTSSetupPopover = false
    @State private var copyConfirmationTimer: DispatchWorkItem?

    private var isUser: Bool { message.role == .user }

    private var hasCopyableText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canInspectMessage: Bool {
        showInspectButton && !isUser && message.daemonMessageId != nil
    }

    private var canForkFromMessage: Bool {
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming
    }

    private var hasOverflowActions: Bool {
        hasCopyableText || canInspectMessage || canForkFromMessage
    }

    private var showOverflowMenu: Bool {
        hasOverflowActions && !message.isStreaming && (hoverState.isHovered || showCopyConfirmation || audioPlayer.isPlaying || audioPlayer.isLoading || showTTSSetupPopover)
    }

    // MARK: - Timestamp Formatters

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateFormat = "MMM d"
        return f
    }()

    private static let detailedFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.dateStyle = .full
        f.timeStyle = .long
        return f
    }()

    private var formattedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        Self.timeFormatter.timeZone = tz
        let timeString = Self.timeFormatter.string(from: message.timestamp)
        if calendar.isDateInToday(message.timestamp) {
            return "Today, \(timeString)"
        } else {
            Self.dayFormatter.timeZone = tz
            return "\(Self.dayFormatter.string(from: message.timestamp)), \(timeString)"
        }
    }

    private var detailedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        Self.detailedFormatter.timeZone = tz
        return Self.detailedFormatter.string(from: message.timestamp)
    }

    // MARK: - Body

    var body: some View {
        if hasOverflowActions {
            menuContent
                .opacity(showOverflowMenu ? 1 : 0)
                .animation(VAnimation.fast, value: showOverflowMenu)
        }
    }

    private var menuContent: some View {
        HStack(spacing: 2) {
            Text(formattedTimestamp)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .help(detailedTimestamp)
            if hasCopyableText {
                VButton(
                    label: showCopyConfirmation ? "Copied" : "Copy message",
                    iconOnly: (showCopyConfirmation ? VIcon.check : VIcon.copy).rawValue,
                    style: .ghost,
                    iconSize: 24,
                    iconColor: showCopyConfirmation ? VColor.systemPositiveStrong : VColor.contentTertiary
                ) {
                    copyMessageText()
                }
                .vTooltip(showCopyConfirmation ? "Copied" : "Copy", edge: .bottom)
                .animation(VAnimation.fast, value: showCopyConfirmation)
            }
            if !isUser && hasCopyableText && isTTSEnabled && message.daemonMessageId != nil {
                ttsButton
            }
            if let onForkFromMessage, let daemonMessageId = message.daemonMessageId, !message.isStreaming {
                VButton(
                    label: "Fork from here",
                    iconOnly: VIcon.gitBranch.rawValue,
                    style: .ghost,
                    iconSize: 24,
                    iconColor: VColor.contentTertiary
                ) {
                    onForkFromMessage(daemonMessageId)
                }
                .vTooltip("Fork from here", edge: .bottom)
            }
            if showInspectButton, !isUser, let daemonMsgId = message.daemonMessageId {
                VButton(
                    label: "Inspect LLM context",
                    iconOnly: VIcon.fileCode.rawValue,
                    style: .ghost,
                    iconSize: 24,
                    iconColor: VColor.contentTertiary
                ) {
                    onInspectMessage?(daemonMsgId)
                }
                .vTooltip("Inspect", edge: .bottom)
            }
        }
        .textSelection(.disabled)
    }

    // MARK: - Copy

    private func copyMessageText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
        copyConfirmationTimer?.cancel()
        showCopyConfirmation = true
        let timer = DispatchWorkItem { showCopyConfirmation = false }
        copyConfirmationTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
    }

    // MARK: - TTS Button

    @ViewBuilder
    private var ttsButton: some View {
        if audioPlayer.isLoading {
            ProgressView()
                .controlSize(.small)
                .frame(width: 24, height: 24)
                .tint(VColor.contentTertiary)
        } else if audioPlayer.isPlaying {
            VButton(
                label: "Stop audio",
                iconOnly: VIcon.square.rawValue,
                style: .ghost,
                iconSize: 24,
                iconColor: VColor.systemPositiveStrong
            ) {
                audioPlayer.stop()
            }
        } else if let daemonMessageId = message.daemonMessageId {
            ttsIdleButton(daemonMessageId: daemonMessageId)
        }
    }

    @ViewBuilder
    private func ttsIdleButton(daemonMessageId: String) -> some View {
        let button = VButton(
            label: "Play as audio",
            iconOnly: VIcon.volume2.rawValue,
            style: .ghost,
            iconSize: 24,
            iconColor: audioPlayer.error != nil ? VColor.systemNegativeStrong : VColor.contentTertiary
        ) {
            Task {
                await audioPlayer.playMessage(
                    messageId: daemonMessageId,
                    conversationId: nil
                )
                if audioPlayer.isNotConfigured {
                    showTTSSetupPopover = true
                }
            }
        }

        if audioPlayer.isNotConfigured {
            button
                .popover(isPresented: $showTTSSetupPopover, arrowEdge: .bottom) {
                    ttsSetupPopoverContent
                }
        } else if audioPlayer.isFeatureDisabled {
            button
                .vTooltip("Text-to-speech is not enabled", edge: .bottom)
        } else {
            button
                .vTooltip("Read aloud", edge: .bottom)
        }
    }

    private var ttsSetupPopoverContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Read aloud isn't set up yet")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentEmphasized)
            Text("Connect a Fish Audio voice to hear messages spoken aloud.")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
            HStack(spacing: VSpacing.md) {
                VButton(label: "Set Up", style: .primary) {
                    showTTSSetupPopover = false
                    AppDelegate.shared?.showSettingsTab("Voice")
                }
                Button {
                    if let url = URL(string: "https://fish.audio") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Text("Learn more")
                        .underline()
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.primaryBase)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: 280)
        .background(VColor.surfaceOverlay)
    }
}
