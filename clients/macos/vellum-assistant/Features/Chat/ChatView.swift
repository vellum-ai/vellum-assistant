import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

private enum ChatTimestampTimeZone {
    private static var cachedZone: TimeZone?
    private static var cacheTimestamp: Date?
    private static let cacheInterval: TimeInterval = 60
    private static var observer: NSObjectProtocol?

    /// Prefer the host's configured timezone over process-level TZ overrides
    /// so chat dividers stay in the user's real local timezone.
    /// Caches the result to avoid repeated filesystem reads in hot rendering paths.
    static func resolve() -> TimeZone {
        // Check if we have a valid cached value
        if let cached = cachedZone,
           let timestamp = cacheTimestamp,
           Date().timeIntervalSince(timestamp) < cacheInterval {
            return cached
        }

        // Register for timezone change notifications if not already registered
        if observer == nil {
            observer = NotificationCenter.default.addObserver(
                forName: NSNotification.Name.NSSystemTimeZoneDidChange,
                object: nil,
                queue: .main
            ) { _ in
                cachedZone = nil
                cacheTimestamp = nil
            }
        }

        // Resolve timezone from /etc/localtime
        let resolved: TimeZone
        if let symlink = try? FileManager.default.destinationOfSymbolicLink(atPath: "/etc/localtime"),
           let markerRange = symlink.range(of: "/zoneinfo/") {
            let identifier = String(symlink[markerRange.upperBound...])
            resolved = TimeZone(identifier: identifier) ?? .autoupdatingCurrent
        } else {
            resolved = .autoupdatingCurrent
        }

        // Update cache
        cachedZone = resolved
        cacheTimestamp = Date()

        return resolved
    }
}

struct ChatView: View {
    let messages: [ChatMessage]
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isThinking: Bool
    let isSending: Bool
    let errorText: String?
    let pendingQueuedCount: Int
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    let isRecording: Bool
    let onOpenSettings: () -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    let onDismissError: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onDropFiles: ([URL]) -> Void
    let onDropImageData: (Data, String?) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAddTrustRule: (String, String, String, String) -> Bool
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onRegenerate: () -> Void
    let sessionError: SessionError?
    let onRetry: () -> Void
    let onDismissSessionError: () -> Void
    let onCopyDebugInfo: () -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    let onOpenActivity: (UUID) -> Void
    let isActivityPanelOpen: Bool

    /// Triggers auto-scroll when the last message's text length changes (e.g. during streaming).
    private var streamingScrollTrigger: Int {
        let last = messages.last
        return (last?.text.count ?? 0) + (last?.toolCalls.count ?? 0) + (last?.inlineSurfaces.count ?? 0)
    }

    @State private var isDropTargeted = false
    @State private var editorContentHeight: CGFloat = 20
    @State private var isComposerExpanded = false
    @AppStorage("useThreadDrawer") private var useThreadDrawer: Bool = false
    @AppStorage("hasEverSentMessage") private var hasEverSentMessage: Bool = false

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                apiKeyBanner
                ZStack(alignment: .bottom) {
                    messageList
                        .safeAreaInset(edge: .bottom) {
                            Color.clear.frame(height: composerReservedHeight)
                                .animation(VAnimation.fast, value: editorContentHeight)
                        }

                    composerOverlay
                }
            }
            .background(alignment: .bottom) {
                chatBackground
            }
            .background(VColor.chatBackground)

            // Drop target overlay
            if isDropTargeted {
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .fill(VColor.accent.opacity(0.08))
                    )
                    .overlay {
                        VStack(spacing: VSpacing.sm) {
                            Image(systemName: "arrow.down.doc.fill")
                                .font(.system(size: 28, weight: .medium))
                                .foregroundColor(VColor.accent)
                            Text("Drop files here")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.accent)
                        }
                    }
                    .padding(VSpacing.lg)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .onDrop(of: [.fileURL, .image, .png, .tiff], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers: providers)
        }
    }

    /// Height reserved at the bottom of the scroll view so the last message isn't hidden behind the composer.
    private var composerReservedHeight: CGFloat {
        let editorClamped = min(max(editorContentHeight, 34), 200)
        let contentHeight = max(editorClamped, 34)
        let expanded = isComposerExpanded
        let topPad: CGFloat = expanded ? VSpacing.md : VSpacing.xs
        let buttonRow: CGFloat = expanded ? 34 + VSpacing.xs : 0
        let base: CGFloat = VSpacing.sm + VSpacing.md + topPad + VSpacing.sm + contentHeight + buttonRow
        let attachments: CGFloat = pendingAttachments.isEmpty ? 0 : 48
        let error: CGFloat = sessionError != nil ? 60 : (errorText != nil ? 36 : 0)
        let queue: CGFloat = pendingQueuedCount > 0 ? 24 : 0
        return base + attachments + error + queue
    }

    @MainActor private var composerOverlay: some View {
        VStack(spacing: 0) {
            if let watchSession, watchSession.state == .capturing {
                WatchProgressView(session: watchSession, onStop: onStopWatch)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let sessionError {
                sessionErrorToast(sessionError)
            } else if let errorText {
                errorBanner(errorText)
            }
            queueSummary
            ComposerView(
                inputText: $inputText,
                hasAPIKey: hasAPIKey,
                isSending: isSending,
                isRecording: isRecording,
                suggestion: suggestion,
                pendingAttachments: pendingAttachments,
                onSend: onSend,
                onStop: onStop,
                onAcceptSuggestion: onAcceptSuggestion,
                onAttach: onAttach,
                onRemoveAttachment: onRemoveAttachment,
                onPaste: onPaste,
                onMicrophoneToggle: onMicrophoneToggle,
                placeholderText: "What would you like to do?",
                editorContentHeight: $editorContentHeight,
                isComposerExpanded: $isComposerExpanded
            )
        }
        .background(
            // Gentle fade that never becomes fully opaque — background stays visible
            LinearGradient(
                stops: [
                    .init(color: VColor.chatBackground.opacity(0), location: 0),
                    .init(color: VColor.chatBackground.opacity(0.5), location: 0.5),
                    .init(color: VColor.chatBackground.opacity(0.65), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        )
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private var chatBackground: some View {
        if let url = ResourceBundle.bundle.url(forResource: "background", withExtension: "png"),
           let nsImage = NSImage(contentsOf: url) {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFit()
                .opacity(colorScheme == .light ? 0 : 1.0)
                .allowsHitTesting(false)
        }
    }

    /// Handle dropped items — supports both file URLs and raw image data.
    /// File URLs are preferred (preserves original filenames); raw image data
    /// is used as a fallback for providers without a backing file (e.g. screenshot
    /// thumbnails or images dragged from certain apps).
    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        var urls: [URL] = []
        var imageDataItems: [NSItemProvider] = []
        let group = DispatchGroup()

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
                        } else if hasImageFallback {
                            // File URL failed (e.g. screenshot not saved yet) — load raw image data instead
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

        group.notify(queue: .main) {
            if !urls.isEmpty { onDropFiles(urls) }
        }
        return true
    }

    // MARK: - Message List

    private func shouldShowTimestamp(at index: Int) -> Bool {
        if index == 0 { return true }
        let current = messages[index].timestamp
        let previous = messages[index - 1].timestamp
        // Always show a divider when crossing a calendar-day boundary (in local timezone)
        var calendar = Calendar.current
        calendar.timeZone = ChatTimestampTimeZone.resolve()
        if !calendar.isDate(current, inSameDayAs: previous) { return true }
        let gap = current.timeIntervalSince(previous)
        return gap > 300
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: VSpacing.lg) {
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        if shouldShowTimestamp(at: index) {
                            TimestampDivider(date: message.timestamp)
                        }

                        if let confirmation = message.confirmation {
                            if confirmation.state == .pending {
                                // Check if the preceding assistant message has text
                                let prevHasText: Bool = {
                                    guard index > 0 else { return false }
                                    let prev = messages[index - 1]
                                    return prev.role == .assistant
                                        && !prev.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                }()

                                // Show pending confirmations as inline buttons
                                ToolConfirmationBubble(
                                    confirmation: confirmation,
                                    showDescription: true,
                                    onAllow: { onConfirmationAllow(confirmation.requestId) },
                                    onDeny: { onConfirmationDeny(confirmation.requestId) },
                                    onAddTrustRule: onAddTrustRule
                                )
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                            }
                            // Decided confirmations are normally rendered as compact chips
                            // on the preceding assistant message's ChatBubble. But if there
                            // is no preceding assistant message, render them inline so they
                            // don't disappear entirely.
                            else {
                                let hasPrecedingAssistant: Bool = {
                                    guard index > 0 else { return false }
                                    return messages[index - 1].role == .assistant
                                }()

                                if !hasPrecedingAssistant {
                                    ToolConfirmationBubble(
                                        confirmation: confirmation,
                                        showDescription: true,
                                        onAllow: { onConfirmationAllow(confirmation.requestId) },
                                        onDeny: { onConfirmationDeny(confirmation.requestId) },
                                        onAddTrustRule: onAddTrustRule
                                    )
                                    .id(message.id)
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                                }
                                // When there IS a preceding assistant message, the decided
                                // confirmation is rendered as a chip on that bubble — skip here.
                            }
                        } else {
                            // Hide tool call chips when the next message is a pending
                            // confirmation — the tool hasn't been approved yet.
                            let nextIsPendingConfirmation = index + 1 < messages.count
                                && messages[index + 1].confirmation?.state == .pending

                            // Pass decided confirmation from the next message so it
                            // renders as a compact chip at the bottom of this bubble.
                            let nextDecidedConfirmation: ToolConfirmationData? = {
                                guard index + 1 < messages.count,
                                      let conf = messages[index + 1].confirmation,
                                      conf.state != .pending else { return nil }
                                return conf
                            }()

                            let isLastAssistant = message.role == .assistant
                                && !message.isStreaming
                                && (index == messages.count - 1
                                    || (index == messages.count - 2
                                        && messages[messages.count - 1].confirmation != nil && messages[messages.count - 1].confirmation?.state != .pending))
                                && !isSending
                                && !isThinking

                            ChatBubble(
                                message: message,
                                hideToolCalls: nextIsPendingConfirmation,
                                decidedConfirmation: nextDecidedConfirmation,
                                showRegenerate: isLastAssistant,
                                onRegenerate: onRegenerate,
                                onSurfaceAction: onSurfaceAction,
                                onOpenActivity: onOpenActivity,
                                isActivityPanelOpen: isActivityPanelOpen
                            )
                                .id(message.id)
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }

                    if isThinking {
                        ThinkingIndicator(label: !hasEverSentMessage && messages.contains(where: { $0.role == .user }) ? "Waking up..." : "Thinking")
                            .id("thinking-indicator")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    // Invisible anchor at the very bottom of all content
                    Color.clear.frame(height: 1)
                        .id("scroll-bottom-anchor")
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, useThreadDrawer ? VSpacing.xs : VSpacing.md)
                .padding(.bottom, VSpacing.md)
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
            }
            .scrollContentBackground(.hidden)
            .scrollDisabled(messages.isEmpty && !isThinking)
            .onAppear {
                // Scroll to bottom on initial load
                proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
            }
            .onChange(of: isThinking) {
                if isThinking {
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                    }
                } else {
                    // Thinking finished — mark flag so next message shows "Thinking"
                    if !hasEverSentMessage && messages.contains(where: { $0.role == .user }) {
                        hasEverSentMessage = true
                    }
                }
            }
            .onChange(of: streamingScrollTrigger) {
                withAnimation(VAnimation.fast) {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            }
            .onChange(of: messages.count) {
                withAnimation(VAnimation.fast) {
                    proxy.scrollTo("scroll-bottom-anchor", anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Error Banner

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(VFont.caption)

            Text(text)
                .font(VFont.caption)
                .lineLimit(2)

            Spacer()

            Button {
                onDismissError()
            } label: {
                Image(systemName: "xmark")
                    .font(VFont.caption)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .foregroundColor(.white)
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.error)
    }

    // MARK: - Session Error Toast

    private func sessionErrorToast(_ error: SessionError) -> some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: sessionErrorIcon(error.category))
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(sessionErrorAccent(error.category))

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(error.message)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Text(error.recoverySuggestion)
                    .font(VFont.small)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(1)
            }

            Spacer()

            if error.isRetryable {
                Button(action: onRetry) {
                    Text(sessionErrorActionLabel(error.category))
                        .font(VFont.captionMedium)
                        .foregroundColor(.white)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                        .background(sessionErrorAccent(error.category))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(sessionErrorActionLabel(error.category))
            }

            if error.debugDetails != nil {
                Button(action: onCopyDebugInfo) {
                    Image(systemName: "doc.on.clipboard")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy debug info")
            }

            Button {
                onDismissSessionError()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(sessionErrorAccent(error.category).opacity(0.1))
        .overlay(
            Rectangle()
                .fill(sessionErrorAccent(error.category))
                .frame(width: 3),
            alignment: .leading
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    /// SF Symbol icon appropriate for each error category.
    private func sessionErrorIcon(_ category: SessionErrorCategory) -> String {
        switch category {
        case .providerNetwork:
            return "wifi.exclamationmark"
        case .rateLimit:
            return "clock.badge.exclamationmark"
        case .providerApi:
            return "exclamationmark.icloud.fill"
        case .queueFull:
            return "tray.full.fill"
        case .sessionAborted:
            return "stop.circle.fill"
        case .processingFailed, .regenerateFailed:
            return "arrow.triangle.2.circlepath"
        case .unknown:
            return "exclamationmark.triangle.fill"
        }
    }

    /// Accent color for each error category -- warm for transient/retryable,
    /// red for hard failures.
    private func sessionErrorAccent(_ category: SessionErrorCategory) -> Color {
        switch category {
        case .rateLimit, .queueFull:
            return VColor.warning
        case .providerNetwork:
            return Amber._500
        case .sessionAborted:
            return VColor.textSecondary
        default:
            return VColor.error
        }
    }

    /// Action button label tailored to the error category.
    private func sessionErrorActionLabel(_ category: SessionErrorCategory) -> String {
        switch category {
        case .rateLimit:
            return "Retry"
        case .regenerateFailed:
            return "Retry"
        case .providerNetwork:
            return "Retry"
        default:
            return "Retry"
        }
    }

    // MARK: - Queue Summary

    @ViewBuilder
    private var queueSummary: some View {
        if pendingQueuedCount > 0 {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "text.line.first.and.arrowtriangle.forward")
                    .font(VFont.caption)
                Text(pendingQueuedCount == 1
                     ? "1 message queued, sending automatically"
                     : "\(pendingQueuedCount) messages queued, sending automatically")
                    .font(VFont.caption)
            }
            .foregroundColor(VColor.textSecondary)
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.xs)
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var apiKeyBanner: some View {
        if !hasAPIKey {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "key.fill")
                    .font(VFont.caption)
                Text("API key not set. Add one in Settings to start chatting.")
                    .font(VFont.caption)
                    .lineLimit(2)
                Spacer()
                Button("Open Settings", action: onOpenSettings)
                    .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .foregroundColor(.white)
            .background(VColor.warning)
        }
    }
}

// MARK: - Chat Bubble

private struct ChatBubble: View {
    let message: ChatMessage
    /// When true, tool call chips are suppressed because a nearby message has inline surfaces.
    let hideToolCalls: Bool
    /// Decided confirmation from the next message, rendered as a compact chip at the bottom.
    let decidedConfirmation: ToolConfirmationData?
    /// Whether to show the regenerate button on this message.
    let showRegenerate: Bool
    let onRegenerate: () -> Void
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onOpenActivity: (UUID) -> Void
    let isActivityPanelOpen: Bool

    private var isUser: Bool { message.role == .user }

    @State private var isExpanded = true
    private let truncationLimit = 2000  // Character limit before truncation
    private let lineLimit = 50  // Maximum lines before truncation

    private var statusLabel: String? {
        switch message.status {
        case .queued(let position):
            return position > 0 ? "Queued (\(ordinal(position)) in line)" : "Queued"
        case .processing:
            return "Sending\u{2026}"
        case .sent:
            return nil
        }
    }

    private var bubbleOpacity: Double {
        switch message.status {
        case .queued: return 0.7
        case .processing: return 0.85
        case .sent: return 1.0
        }
    }

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            AnyShapeStyle(VColor.userBubble)
        } else {
            AnyShapeStyle(Color.clear)
        }
    }

    private var formattedTimestamp: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateFormat = "H:mm"
        let timeString = formatter.string(from: message.timestamp)
        if calendar.isDateInToday(message.timestamp) {
            return "Today, \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.timeZone = tz
            dayFormatter.dateFormat = "MMM d"
            return "\(dayFormatter.string(from: message.timestamp)), \(timeString)"
        }
    }

    /// Whether the text/attachment bubble should be rendered.
    /// Tool calls for assistant messages render outside the bubble as separate chips,
    /// so only show the bubble when there's actual text or attachment content.
    ///
    /// NOTE: When inline surfaces are present, the bubble is intentionally hidden
    /// even if the message also contains text. This is by design — the assistant's
    /// text in these cases is typically a preamble (e.g. "Here's what I built:")
    /// that should not appear above the rendered dynamic UI surface.
    private var shouldShowBubble: Bool {
        if isUser { return true }
        if !message.inlineSurfaces.isEmpty {
            // Show bubble text when all surfaces are completed (collapsed to chips)
            let allCompleted = message.inlineSurfaces.allSatisfy { $0.completionState != nil }
            if !allCompleted { return false }
        }
        return hasText || !message.attachments.isEmpty
    }


    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 0) }

            VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                if !isUser && hasInterleavedContent {
                    interleavedContent
                } else {
                    if shouldShowBubble {
                        bubbleContent
                    }

                    // Inline surfaces render below the bubble as full-width cards
                    if !message.inlineSurfaces.isEmpty {
                        ForEach(message.inlineSurfaces) { surface in
                            InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction)
                        }
                    }
                }

                // Single unified status area at the bottom of the message:
                // - In-progress: shows "Running a terminal command ..."
                // - Complete: shows compact chips ("Ran a terminal command" + "Permission granted")
                if !isUser {
                    trailingStatus
                }

                if let label = statusLabel {
                    Text(label)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }

            if !isUser { Spacer(minLength: 0) }
        }
    }

    // MARK: - Compact trailing chips (tool calls + permission)

    /// Whether all tool calls are complete and the message is done streaming.
    private var allToolCallsComplete: Bool {
        !message.toolCalls.isEmpty && message.toolCalls.allSatisfy { $0.isComplete } && !message.isStreaming
    }

    private var regenerateButton: some View {
        Button(action: onRegenerate) {
            Image(systemName: "arrow.trianglehead.counterclockwise")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(VColor.textMuted)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Regenerate response")
        .help("Regenerate response")
    }

    /// Whether the permission was denied, meaning incomplete tools were blocked (not running).
    private var permissionWasDenied: Bool {
        decidedConfirmation?.state == .denied || decidedConfirmation?.state == .timedOut
    }

    @ViewBuilder
    private var trailingStatus: some View {
        let hasCompletedTools = allToolCallsComplete && !hideToolCalls && !message.toolCalls.isEmpty
        /// True when there is at least one tool call that hasn't finished yet.
        let hasActuallyRunningTool = !hideToolCalls && message.toolCalls.contains(where: { !$0.isComplete })
        /// All individual tool calls done but message still streaming (model generating next tool call).
        let toolsCompleteButStillStreaming = !hideToolCalls && !message.toolCalls.isEmpty
            && message.toolCalls.allSatisfy({ $0.isComplete }) && message.isStreaming
        let hasInProgressTools = !message.toolCalls.isEmpty && !hideToolCalls && !allToolCallsComplete
        let hasPermission = decidedConfirmation != nil
        let hasStreamingCode = message.streamingCodePreview != nil && !(message.streamingCodePreview?.isEmpty ?? true)

        if hasStreamingCode {
            let rawName = message.streamingCodeToolName ?? ""
            let displayName = rawName.replacingOccurrences(of: "_", with: " ")
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                RunningIndicator(label: Self.friendlyRunningLabel(displayName))
                CodePreviewView(code: message.streamingCodePreview!)
            }
            .frame(maxWidth: 520, alignment: .leading)
        } else if hasActuallyRunningTool && !permissionWasDenied {
            // In progress — show single running indicator for the active tool
            let current = message.toolCalls.first(where: { !$0.isComplete })!
            let progressive = Self.progressiveLabels(for: current.toolName)
            RunningIndicator(
                label: Self.friendlyRunningLabel(current.toolName, inputSummary: current.inputSummary),
                progressiveLabels: progressive,
                labelInterval: progressive.isEmpty ? 6 : 15
            )
                .frame(maxWidth: 520, alignment: .leading)
        } else if toolsCompleteButStillStreaming && !permissionWasDenied {
            // All tools done but model is still working (generating next tool call)
            RunningIndicator(label: "Working")
                .frame(maxWidth: 520, alignment: .leading)
        } else if hasCompletedTools || hasPermission || showRegenerate || (hasInProgressTools && permissionWasDenied) {
            // All done (or denied) — show chips + regenerate on one line
            HStack(spacing: VSpacing.sm) {
                if hasCompletedTools {
                    compactToolChip
                } else if hasInProgressTools && permissionWasDenied {
                    compactFailedToolChip
                }
                if let confirmation = decidedConfirmation {
                    compactPermissionChip(confirmation)
                }
                if showRegenerate {
                    regenerateButton
                }
                Spacer()
            }
            .padding(.top, VSpacing.xxs)
        }
    }

    /// Maps raw tool names to user-friendly past-tense labels.
    private static func friendlyToolLabel(_ toolName: String) -> String {
        switch toolName.lowercased() {
        case "host bash", "bash":          return "Ran a terminal command"
        case "host file read", "file read": return "Read a file"
        case "host file write", "file write": return "Wrote a file"
        case "host file edit", "file edit": return "Edited a file"
        case "web search":                 return "Searched the web"
        case "web fetch":                  return "Fetched a webpage"
        case "browser navigate":           return "Opened a page"
        case "browser click":              return "Clicked on the page"
        case "browser screenshot":         return "Took a screenshot"
        default:                           return "Used \(toolName)"
        }
    }

    /// Maps raw tool names to user-friendly present-tense labels for the running state.
    private static func friendlyRunningLabel(_ toolName: String, inputSummary: String? = nil) -> String {
        switch toolName.lowercased() {
        case "host bash", "bash":                           return "Running a terminal command"
        case "host file read", "file read":                 return "Reading a file"
        case "host file write", "file write":               return "Writing a file"
        case "host file edit", "file edit":                 return "Editing a file"
        case "web search":                                  return "Searching the web"
        case "web fetch":                                   return "Fetching a webpage"
        case "browser navigate":                            return "Opening a page"
        case "browser click":                               return "Clicking on the page"
        case "browser screenshot":                          return "Taking a screenshot"
        case "app create":                                  return "Building your app"
        case "app update":                                  return "Updating your app"
        case "skill load":
            if let name = inputSummary, !name.isEmpty {
                let display = name.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
                return "Loading \(display)"
            }
            return "Loading a skill"
        default:                                            return "Running \(toolName)"
        }
    }

    /// Progressive labels for long-running tools. Cycles through these over time.
    private static func progressiveLabels(for toolName: String) -> [String] {
        switch toolName.lowercased() {
        case "app create":
            return [
                "Choosing a visual direction",
                "Designing the layout",
                "Writing the interface",
                "Adding styles and colors",
                "Wiring up interactions",
                "Polishing the details",
                "Almost there",
            ]
        case "app update":
            return [
                "Reviewing your app",
                "Applying changes",
                "Updating the interface",
                "Polishing the details",
            ]
        default:
            return []
        }
    }

    /// Icon for a tool category.
    private static func friendlyToolIcon(_ toolName: String) -> String {
        switch toolName.lowercased() {
        case "host bash", "bash":                           return "terminal"
        case "host file read", "file read":                 return "doc.text"
        case "host file write", "file write":               return "doc.badge.plus"
        case "host file edit", "file edit":                 return "pencil"
        case "web search":                                  return "magnifyingglass"
        case "web fetch":                                   return "globe"
        case "browser navigate", "browser click":           return "safari"
        case "browser screenshot":                          return "camera"
        default:                                            return "gearshape"
        }
    }

    private var compactToolChip: some View {
        Button {
            onOpenActivity(message.id)
        } label: {
            HStack(spacing: VSpacing.xs) {
                let uniqueNames = Array(Set(message.toolCalls.map(\.toolName))).sorted()
                let primary = uniqueNames.first ?? "Tool"

                Image(systemName: Self.friendlyToolIcon(primary))
                    .font(.system(size: 12))
                    .foregroundColor(VColor.textMuted)

                let label: String = {
                    if uniqueNames.count == 1 {
                        let base = Self.friendlyToolLabel(primary)
                        if message.toolCalls.count > 1 {
                            // e.g. "Ran 3 terminal commands"
                            return base
                                .replacingOccurrences(of: "a terminal command", with: "\(message.toolCalls.count) terminal commands")
                                .replacingOccurrences(of: "a file", with: "\(message.toolCalls.count) files")
                                .replacingOccurrences(of: "a page", with: "\(message.toolCalls.count) pages")
                                .replacingOccurrences(of: "a webpage", with: "\(message.toolCalls.count) webpages")
                        }
                        return base
                    }
                    return "Used \(message.toolCalls.count) tools"
                }()

                Text(label)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)

                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundColor(VColor.textMuted)
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(
                Capsule().fill(VColor.surface)
            )
            .overlay(
                Capsule().stroke(VColor.surfaceBorder, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    /// Failed/denied tool chip — shown when the user denied permission.
    private var compactFailedToolChip: some View {
        let uniqueNames = Array(Set(message.toolCalls.map(\.toolName))).sorted()
        let primary = uniqueNames.first ?? "Tool"
        let label = Self.friendlyRunningLabel(primary) + " failed"

        return HStack(spacing: VSpacing.xs) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.error)

            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(VColor.surface)
        )
        .overlay(
            Capsule().stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    private func compactPermissionChip(_ confirmation: ToolConfirmationData) -> some View {
        let isApproved = confirmation.state == .approved
        return HStack(spacing: VSpacing.xs) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                case .denied:
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(isApproved ? "Permission granted" :
                 confirmation.state == .denied ? "Permission denied" : "Timed out")
                .font(VFont.caption)
                .foregroundColor(isApproved ? VColor.success : VColor.textSecondary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule().fill(isApproved ? VColor.success.opacity(0.1) : VColor.surface)
        )
        .overlay(
            Capsule().stroke(isApproved ? VColor.success.opacity(0.3) : VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    /// Whether this message has meaningful interleaved content (multiple block types).
    private var hasInterleavedContent: Bool {
        // Use interleaved path when contentOrder has more than one distinct block type
        guard message.contentOrder.count > 1 else { return false }
        var hasText = false
        var hasNonText = false
        for ref in message.contentOrder {
            switch ref {
            case .text: hasText = true
            case .toolCall, .surface: hasNonText = true
            }
            if hasText && hasNonText { return true }
        }
        return false
    }

    /// Groups consecutive tool call refs for rendering.
    private enum ContentGroup {
        case text(Int)
        case toolCalls([Int])
        case surface(Int)
    }

    private func groupContentBlocks() -> [ContentGroup] {
        var groups: [ContentGroup] = []
        for ref in message.contentOrder {
            switch ref {
            case .text(let i):
                groups.append(.text(i))
            case .toolCall(let i):
                if case .toolCalls(let indices) = groups.last {
                    groups[groups.count - 1] = .toolCalls(indices + [i])
                } else {
                    groups.append(.toolCalls([i]))
                }
            case .surface(let i):
                groups.append(.surface(i))
            }
        }
        return groups
    }

    @ViewBuilder
    private var interleavedContent: some View {
        let groups = groupContentBlocks()

        // Render all content groups in order: text, tool calls, and surfaces
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
            switch group {
            case .text(let i):
                if i < message.textSegments.count {
                    let segmentText = message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines)
                    if !segmentText.isEmpty {
                        textBubble(for: segmentText)
                    }
                }
            case .toolCalls:
                // Tool calls are rendered by trailingStatus below the message
                EmptyView()
            case .surface(let i):
                if i < message.inlineSurfaces.count {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction)
                }
            }
        }

        // Attachments are not part of contentOrder but must still be rendered
        let partitioned = partitionedAttachments
        if !partitioned.images.isEmpty {
            attachmentImageGrid(partitioned.images)
        }
        if !partitioned.files.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(partitioned.files) { attachment in
                    fileAttachmentChip(attachment)
                }
            }
        }
    }

    /// Render a single text segment as a styled bubble, with table support.
    @ViewBuilder
    private func textBubble(for segmentText: String) -> some View {
        let segments = parseMarkdownSegments(segmentText)
        let hasTable = segments.contains(where: {
            if case .table = $0 { return true }; return false
        })

        if hasTable {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    switch segment {
                    case .text(let text):
                        let options = AttributedString.MarkdownParsingOptions(
                            interpretedSyntax: .inlineOnlyPreservingWhitespace
                        )
                        let attributed = (try? AttributedString(markdown: text, options: options))
                            ?? AttributedString(text)
                        Text(attributed)
                            .font(.system(size: 13))
                            .foregroundColor(VColor.textPrimary)
                            .tint(VColor.accent)
                            .textSelection(.enabled)
                            .frame(maxWidth: 520, alignment: .leading)
                    case .table(let headers, let rows):
                        MarkdownTableView(headers: headers, rows: rows)
                    }
                }
            }
        } else {
            let options = AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
            let attributed = (try? AttributedString(markdown: segmentText, options: options))
                ?? AttributedString(segmentText)
            Text(attributed)
                .font(.system(size: 13))
                .foregroundColor(VColor.textPrimary)
                .tint(VColor.accent)
                .textSelection(.enabled)
                .frame(maxWidth: 520, alignment: .leading)
        }
    }

    /// Current step indicator rendered outside the bubble.
    /// Shows only when there are actual tool calls.
    // Tool call status is rendered via trailingStatus at the bottom of the message.

    private var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var shouldTruncate: Bool {
        if isExpanded { return false }
        let charCount = message.text.count
        let lineCount = message.text.components(separatedBy: .newlines).count
        return charCount > truncationLimit || lineCount > lineLimit
    }

    private var displayText: String {
        if shouldTruncate {
            let lines = message.text.components(separatedBy: .newlines)
            if lines.count > lineLimit {
                // Truncate by line count
                let truncatedLines = lines.prefix(lineLimit)
                return truncatedLines.joined(separator: "\n")
            } else {
                // Truncate by character count
                return String(message.text.prefix(truncationLimit))
            }
        }
        return message.text
    }

    private var truncationMessage: String {
        let charCount = message.text.count
        let lineCount = message.text.components(separatedBy: .newlines).count

        if lineCount > lineLimit {
            let hiddenLines = lineCount - lineLimit
            return "Show more (\(hiddenLines) more lines)"
        } else if charCount > truncationLimit {
            let hiddenChars = charCount - truncationLimit
            return "Show more (\(hiddenChars) more characters)"
        }
        return "Show more"
    }

    private var attachmentSummary: String {
        let count = message.attachments.count
        if count == 1 {
            return "Sent \(message.attachments[0].filename)"
        }
        return "Sent \(count) attachments"
    }

    /// Partitions attachments into decoded images and non-image files in a single pass,
    /// avoiding redundant base64 decoding and NSImage construction across render calls.
    private var partitionedAttachments: (images: [(ChatAttachment, NSImage)], files: [ChatAttachment]) {
        var images: [(ChatAttachment, NSImage)] = []
        var files: [ChatAttachment] = []
        for attachment in message.attachments {
            if attachment.mimeType.hasPrefix("image/"), let img = nsImage(for: attachment) {
                images.append((attachment, img))
            } else {
                files.append(attachment)
            }
        }
        return (images, files)
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let skillInvocation = message.skillInvocation {
                SkillInvocationChip(data: skillInvocation)
            }

            if hasText {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    let segments = parseMarkdownSegments(displayText)
                    let hasTable = segments.contains(where: {
                        if case .table = $0 { return true }; return false
                    })

                    if hasTable {
                        ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                            switch segment {
                            case .text(let text):
                                let options = AttributedString.MarkdownParsingOptions(
                                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                                )
                                let attributed = (try? AttributedString(markdown: text, options: options))
                                    ?? AttributedString(text)
                                Text(attributed)
                                    .font(.system(size: 13))
                                    .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                    .tint(isUser ? VColor.userBubbleText : VColor.accent)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            case .table(let headers, let rows):
                                MarkdownTableView(headers: headers, rows: rows)
                            }
                        }
                    } else {
                        Text(markdownText)
                            .font(.system(size: 13))
                            .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                            .tint(isUser ? VColor.userBubbleText : VColor.accent)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if shouldTruncate || (isExpanded && (message.text.count > truncationLimit || message.text.components(separatedBy: .newlines).count > lineLimit)) {
                        Button(action: { isExpanded.toggle() }) {
                            Text(isExpanded ? "Show less" : truncationMessage)
                                .font(VFont.caption)
                                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.accent)
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else if !message.attachments.isEmpty {
                Text(attachmentSummary)
                    .font(VFont.caption)
                    .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)
            }

            if !partitioned.images.isEmpty {
                attachmentImageGrid(partitioned.images)
            }

            if !partitioned.files.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(partitioned.files) { attachment in
                        fileAttachmentChip(attachment)
                    }
                }
            }

            // User messages keep tool calls inside the bubble
            if isUser && !message.toolCalls.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    ForEach(message.toolCalls) { toolCall in
                        ToolCallChip(toolCall: toolCall)
                    }
                }
            }
        }
        .padding(.horizontal, isUser ? VSpacing.lg : 0)
        .padding(.vertical, isUser ? VSpacing.md : 0)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(bubbleFill)
        )
        .frame(maxWidth: 520, alignment: isUser ? .trailing : .leading)
        .opacity(bubbleOpacity)
    }

    private func attachmentImageGrid(_ images: [(ChatAttachment, NSImage)]) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            ForEach(images, id: \.0.id) { attachment, nsImage in
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 280)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .onTapGesture {
                        openImageInPreview(attachment)
                    }
            }
        }
    }

    private func fileAttachmentChip(_ attachment: ChatAttachment) -> some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: fileIcon(for: attachment.mimeType))
                .font(VFont.caption)
                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                .lineLimit(1)

            Text(formattedFileSize(base64Length: attachment.dataLength))
                .font(VFont.small)
                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textMuted)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isUser ? VColor.userBubbleText.opacity(0.15) : VColor.surfaceBorder.opacity(0.5))
        )
    }

    private func nsImage(for attachment: ChatAttachment) -> NSImage? {
        if let thumbnailData = attachment.thumbnailData, let img = NSImage(data: thumbnailData) {
            return img
        }
        if let data = Data(base64Encoded: attachment.data), let img = NSImage(data: data) {
            return img
        }
        return nil
    }

    private func openImageInPreview(_ attachment: ChatAttachment) {
        guard let data = Data(base64Encoded: attachment.data) else { return }
        let tempDir = FileManager.default.temporaryDirectory
        let fileURL = tempDir.appendingPathComponent(attachment.filename)
        do {
            try data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        } catch {
            // Silently fail — not critical
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("text/") { return "doc.text.fill" }
        if mimeType == "application/pdf" { return "doc.fill" }
        if mimeType.contains("zip") || mimeType.contains("archive") { return "doc.zipper" }
        if mimeType.contains("json") || mimeType.contains("xml") { return "doc.text.fill" }
        return "doc.fill"
    }

    private func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        return String(format: "%.1f MB", mb)
    }

    /// Cached markdown parser to avoid re-parsing on every render.
    /// Uses the message text hash as the cache key.
    private static var markdownCache = [Int: AttributedString]()
    private static let maxCacheSize = 100

    private var markdownText: AttributedString {
        let textToRender = displayText
        let trimmed = textToRender.trimmingCharacters(in: .whitespacesAndNewlines)
        let cacheKey = trimmed.hashValue

        // Return cached value if available
        if let cached = Self.markdownCache[cacheKey] {
            return cached
        }

        // Parse markdown
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let parsed = (try? AttributedString(markdown: trimmed, options: options))
            ?? AttributedString(trimmed)

        // Store in cache (with size limit to prevent unbounded growth)
        if Self.markdownCache.count >= Self.maxCacheSize {
            // Simple FIFO eviction - remove first entry
            if let firstKey = Self.markdownCache.keys.first {
                Self.markdownCache.removeValue(forKey: firstKey)
            }
        }
        Self.markdownCache[cacheKey] = parsed

        return parsed
    }

    private func ordinal(_ n: Int) -> String {
        let suffix: String
        let ones = n % 10
        let tens = (n / 10) % 10
        if tens == 1 {
            suffix = "th"
        } else {
            switch ones {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix)"
    }
}

// MARK: - Markdown Table Support

/// A segment of message content — either plain text or a parsed table.
private enum MarkdownSegment {
    case text(String)
    case table(headers: [String], rows: [[String]])
}

/// Parses message text into segments, extracting pipe-delimited markdown tables.
private func parseMarkdownSegments(_ text: String) -> [MarkdownSegment] {
    let lines = text.components(separatedBy: .newlines)
    var segments: [MarkdownSegment] = []
    var currentText: [String] = []
    var i = 0

    while i < lines.count {
        // Check for table: need header row + separator row + at least one data row
        if i + 2 < lines.count,
           isTableRow(lines[i]),
           isTableSeparator(lines[i + 1]),
           isTableRow(lines[i + 2]) {
            // Flush accumulated text
            let pending = currentText.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !pending.isEmpty {
                segments.append(.text(pending))
            }
            currentText = []

            // Parse headers
            let headers = parseTableCells(lines[i])
            i += 2  // skip separator

            // Parse data rows
            var rows: [[String]] = []
            while i < lines.count, isTableRow(lines[i]) {
                let cells = parseTableCells(lines[i])
                // Pad or trim to match header count
                let padded = Array(cells.prefix(headers.count))
                    + Array(repeating: "", count: max(0, headers.count - cells.count))
                rows.append(padded)
                i += 1
            }

            segments.append(.table(headers: headers, rows: rows))
        } else {
            currentText.append(lines[i])
            i += 1
        }
    }

    // Flush remaining text
    let remaining = currentText.joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    if !remaining.isEmpty {
        segments.append(.text(remaining))
    }

    return segments
}

private func isTableRow(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return trimmed.hasPrefix("|") && trimmed.hasSuffix("|")
        && trimmed.filter({ $0 == "|" }).count >= 2
}

private func isTableSeparator(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("|") && trimmed.hasSuffix("|") else { return false }
    let inner = trimmed.dropFirst().dropLast()
    // Each cell should be dashes (with optional colons for alignment)
    return inner.split(separator: "|").allSatisfy { cell in
        let c = cell.trimmingCharacters(in: .whitespaces)
        return !c.isEmpty && c.allSatisfy({ $0 == "-" || $0 == ":" })
    }
}

private func parseTableCells(_ line: String) -> [String] {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    let inner = String(trimmed.dropFirst().dropLast())  // strip outer pipes
    return inner.components(separatedBy: "|")
        .map { $0.trimmingCharacters(in: .whitespaces) }
}

/// Renders a parsed markdown table.
private struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                    Text(header)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xs)
                }
            }
            .background(VColor.backgroundSubtle)

            Divider().background(VColor.surfaceBorder)

            // Data rows
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        inlineMarkdownCell(cell)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                    }
                }
                .background(rowIdx % 2 == 1 ? VColor.backgroundSubtle.opacity(0.5) : Color.clear)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
        .frame(maxWidth: 520, alignment: .leading)
    }

    private func inlineMarkdownCell(_ text: String) -> some View {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let attributed = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
        return Text(attributed)
            .font(VFont.caption)
            .foregroundColor(VColor.textPrimary)
    }
}

// MARK: - Thinking Indicator

/// Minimal in-progress indicator for tool execution, matching ThinkingIndicator style.
/// Supports progressive labels that cycle on a timer for long-running tools.
private struct RunningIndicator: View {
    var label: String = "Running"
    /// Optional sequence of labels to cycle through over time.
    var progressiveLabels: [String] = []
    /// Seconds between each label transition.
    var labelInterval: TimeInterval = 6

    @State private var phase: Int = 0
    @State private var timer: Timer?
    @State private var currentLabelIndex: Int = 0
    @State private var labelTimer: Timer?

    private var displayLabel: String {
        if progressiveLabels.isEmpty { return label }
        return progressiveLabels[min(currentLabelIndex, progressiveLabels.count - 1)]
    }

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: "terminal")
                .font(.system(size: 10))
                .foregroundColor(VColor.textSecondary)

            Text(displayLabel)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .animation(.easeInOut(duration: 0.3), value: currentLabelIndex)

            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.textSecondary)
                    .frame(width: 5, height: 5)
                    .opacity(dotOpacity(for: index))
            }

            Spacer()
        }
        .onAppear {
            startDotAnimation()
            startLabelCycling()
        }
        .onDisappear {
            timer?.invalidate()
            labelTimer?.invalidate()
        }
    }

    private func dotOpacity(for index: Int) -> Double {
        phase == index ? 1.0 : 0.4
    }

    private func startDotAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }

    private func startLabelCycling() {
        guard !progressiveLabels.isEmpty else { return }
        labelTimer = Timer.scheduledTimer(withTimeInterval: labelInterval, repeats: true) { _ in
            if currentLabelIndex < progressiveLabels.count - 1 {
                currentLabelIndex += 1
            }
        }
    }
}

private struct CodePreviewView: View {
    let code: String

    var body: some View {
        ScrollView {
            Text(displayCode)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
        }
        .frame(maxHeight: 120)
        .background(VColor.background.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.surfaceBorder, lineWidth: 0.5)
        )
    }

    private var displayCode: String {
        let lines = code.components(separatedBy: "\n")
        if lines.count > 30 {
            return lines.suffix(30).joined(separator: "\n")
        }
        return code
    }
}

private struct ThinkingIndicator: View {
    var label: String = "Thinking"
    @State private var phase: Int = 0
    @State private var timer: Timer?

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Image("OwlIcon")
                .resizable()
                .scaledToFit()
                .frame(width: 12, height: 12)
                .foregroundColor(VColor.textSecondary)

            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.textSecondary)
                    .frame(width: 5, height: 5)
                    .opacity(dotOpacity(for: index))
            }

            Spacer()
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
    }

    private func dotOpacity(for index: Int) -> Double {
        phase == index ? 1.0 : 0.4
    }

    private func startAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }
}

// MARK: - Timestamp Divider

private struct TimestampDivider: View {
    let date: Date

    private var formattedTime: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateFormat = "h:mm a"
        let timeString = formatter.string(from: date)
        if calendar.isDateInToday(date) {
            return "Today at \(timeString)"
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday at \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.timeZone = tz
            dayFormatter.dateFormat = "MMM d"
            return "\(dayFormatter.string(from: date)) at \(timeString)"
        }
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            line
            Text(formattedTime)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
            line
        }
        .padding(.vertical, VSpacing.xs)
    }

    private var line: some View {
        Rectangle()
            .fill(VColor.surfaceBorder.opacity(0.3))
            .frame(height: 0.5)
    }
}

// MARK: - Preview

#if DEBUG
struct ChatView_Preview: PreviewProvider {
    static var previews: some View {
        ChatViewPreviewWrapper()
            .frame(width: 600, height: 500)
            .previewDisplayName("ChatView")
    }
}

private struct ChatViewPreviewWrapper: View {
    @State private var text = ""

    private let sampleMessages: [ChatMessage] = [
        ChatMessage(role: .assistant, text: "Hello! How can I help you today?"),
        ChatMessage(role: .user, text: "Can you tell me about SwiftUI?"),
        ChatMessage(
            role: .assistant,
            text: "SwiftUI is a declarative framework for building user interfaces across Apple platforms. It uses a reactive data-binding model and composable view hierarchy."
        ),
        ChatMessage(role: .user, text: "That sounds great, thanks!"),
    ]

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            ChatView(
                messages: sampleMessages,
                inputText: $text,
                hasAPIKey: true,
                isThinking: true,
                isSending: false,
                errorText: nil,
                pendingQueuedCount: 0,
                suggestion: "That sounds great, thanks!",
                pendingAttachments: [],
                isRecording: false,
                onOpenSettings: {},
                onSend: {},
                onStop: {},
                onDismissError: {},
                onAcceptSuggestion: {},
                onAttach: {},
                onRemoveAttachment: { _ in },
                onDropFiles: { _ in },
                onDropImageData: { _, _ in },
                onPaste: {},
                onMicrophoneToggle: {},
                onConfirmationAllow: { _ in },
                onConfirmationDeny: { _ in },
                onAddTrustRule: { _, _, _, _ in true },
                onSurfaceAction: { _, _, _ in },
                onRegenerate: {},
                sessionError: nil,
                onRetry: {},
                onDismissSessionError: {},
                onCopyDebugInfo: {},
                watchSession: nil,
                onStopWatch: {},
                onOpenActivity: { _ in },
                isActivityPanelOpen: false
            )
        }
    }
}
#endif
