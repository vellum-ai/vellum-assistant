import Observation
import SwiftUI
import VellumAssistantShared

// MARK: - Hover State

/// Shared hover state for a chat bubble, scoped so only the overflow menu
/// is invalidated on hover changes rather than the entire bubble body.
/// https://developer.apple.com/videos/play/wwdc2023/10149/
@MainActor @Observable
final class ChatBubbleHoverState {
    var isHovered = false
}

// MARK: - Overflow Menu

/// Timestamp, copy, TTS, fork, and inspect actions shown on hover.
/// Owns volatile @State (copy confirmation, audio player, popover) so that
/// changes only re-evaluate this small view, not the full ChatBubble body.
struct ChatBubbleOverflowMenu: View {
    private static let reservedRowHeight: CGFloat = 24

    let message: ChatMessage
    let hoverState: ChatBubbleHoverState
    let isTTSEnabled: Bool
    let showInspectButton: Bool
    var onForkFromMessage: ((String) -> Void)?
    var onInspectMessage: ((String?) -> Void)?
    var bookmarkStore: BookmarkStore?
    var onToggleBookmark: ((String, String) -> Void)?
    var conversationId: String?

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
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming && MacOSClientFeatureFlagManager.shared.isEnabled("fork-from-message")
    }

    private var canBookmarkMessage: Bool {
        onToggleBookmark != nil && bookmarkStore != nil && message.daemonMessageId != nil && conversationId != nil && !message.isStreaming && MacOSClientFeatureFlagManager.shared.isEnabled("bookmarks")
    }

    private var hasOverflowActions: Bool {
        hasCopyableText || canInspectMessage || canForkFromMessage || canBookmarkMessage
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
            Color.clear
                .frame(height: Self.reservedRowHeight)
                .overlay(alignment: isUser ? .trailing : .leading) {
                    if showOverflowMenu {
                        menuContent
                            .transition(.opacity)
                    }
                }
                .animation(VAnimation.fast, value: showOverflowMenu)
        }
    }

    private var menuContent: some View {
        HStack(spacing: 2) {
            Text(formattedTimestamp)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
                .nativeTooltip(detailedTimestamp)
            if hasCopyableText {
                ChatEquatableButton(
                    label: showCopyConfirmation ? "Copied" : "Copy message",
                    iconOnly: (showCopyConfirmation ? VIcon.check : VIcon.copy).rawValue,
                    iconColorRole: showCopyConfirmation ? .systemPositiveStrong : .contentTertiary
                ) {
                    copyMessageText()
                }
                .equatable()
                .vTooltip(showCopyConfirmation ? "Copied" : "Copy", edge: .bottom)
                .animation(VAnimation.fast, value: showCopyConfirmation)
            }
            if !isUser && hasCopyableText && isTTSEnabled && message.daemonMessageId != nil {
                ttsButton
            }
            if let onForkFromMessage, let daemonMessageId = message.daemonMessageId, !message.isStreaming {
                ChatEquatableButton(
                    label: "Fork from here",
                    iconOnly: VIcon.gitBranch.rawValue
                ) {
                    onForkFromMessage(daemonMessageId)
                }
                .equatable()
                .vTooltip("Fork from here", edge: .bottom)
            }
            if showInspectButton, !isUser, let daemonMsgId = message.daemonMessageId {
                ChatEquatableButton(
                    label: "Inspect LLM context",
                    iconOnly: VIcon.fileCode.rawValue
                ) {
                    onInspectMessage?(daemonMsgId)
                }
                .equatable()
                .vTooltip("Inspect", edge: .bottom)
            }
            if let onToggleBookmark, let store = bookmarkStore,
               let daemonMessageId = message.daemonMessageId,
               let conversationId,
               !message.isStreaming,
               MacOSClientFeatureFlagManager.shared.isEnabled("bookmarks") {
                let isBookmarked = store.bookmarkedMessageIds.contains(daemonMessageId)
                ChatEquatableButton(
                    label: isBookmarked ? "Remove bookmark" : "Bookmark message",
                    iconOnly: VIcon.bookmark.rawValue,
                    iconColorRole: isBookmarked ? .primaryBase : .contentTertiary
                ) {
                    onToggleBookmark(daemonMessageId, conversationId)
                }
                .equatable()
                .vTooltip(isBookmarked ? "Bookmarked" : "Bookmark", edge: .bottom)
            }
        }
        .textSelection(.disabled)
    }

    // MARK: - Copy

    private func copyMessageText() {
        let pasteboard = NSPasteboard.general
        let textToCopy = message.text

        pasteboard.clearContents()
        pasteboard.setString(textToCopy, forType: .string)

        // Verify the write landed. If another pasteboard writer (e.g. a delayed
        // clipboard-restore timer from ActionExecutor or DictationTextInserter)
        // overwrites us, re-claim ownership.
        // Reference: https://developer.apple.com/documentation/appkit/nspasteboard/changecount
        let expectedChangeCount = pasteboard.changeCount
        DispatchQueue.main.async {
            let pb = NSPasteboard.general
            if pb.changeCount != expectedChangeCount {
                pb.clearContents()
                pb.setString(textToCopy, forType: .string)
            }
        }

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
            ChatEquatableButton(
                label: "Stop audio",
                iconOnly: VIcon.square.rawValue,
                iconColorRole: .systemPositiveStrong
            ) {
                audioPlayer.stop()
            }
            .equatable()
        } else if let daemonMessageId = message.daemonMessageId {
            ttsIdleButton(daemonMessageId: daemonMessageId)
        }
    }

    @ViewBuilder
    private func ttsIdleButton(daemonMessageId: String) -> some View {
        let button = ChatEquatableButton(
            label: "Play as audio",
            iconOnly: VIcon.volume2.rawValue,
            iconColorRole: audioPlayer.error != nil ? .systemNegativeStrong : .contentTertiary
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
                .equatable()
                .popover(isPresented: $showTTSSetupPopover, arrowEdge: .bottom) {
                    ttsSetupPopoverContent
                }
        } else if audioPlayer.isFeatureDisabled {
            button
                .equatable()
                .vTooltip("Text-to-speech is not enabled", edge: .bottom)
        } else {
            button
                .equatable()
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
