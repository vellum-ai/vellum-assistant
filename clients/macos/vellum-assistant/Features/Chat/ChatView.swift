import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

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
    var isLoadingAttachment: Bool = false
    let isRecording: Bool
    let onOpenSettings: () -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    let onDismissError: () -> Void
    let isRetryableError: Bool
    let onRetryError: () -> Void
    let isConnectionError: Bool
    var hasRetryPayload: Bool = true
    let isSecretBlockError: Bool
    let onSendAnyway: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onDropFiles: ([URL]) -> Void
    let onDropImageData: (Data, String?) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    var onModelPickerSelect: ((UUID, String) -> Void)?
    var selectedModel: String = ""
    var configuredProviders: Set<String> = []
    let onConfirmationAllow: (String) -> Void
    let onConfirmationDeny: (String) -> Void
    let onAlwaysAllow: (String, String, String, String) -> Void
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let sessionError: SessionError?
    let onRetry: () -> Void
    let onDismissSessionError: () -> Void
    let onCopyDebugInfo: () -> Void
    let watchSession: WatchSession?
    var isLearnMode: Bool = false
    var networkEntryCount: Int = 0
    var idleHint: Bool = false
    let onStopWatch: () -> Void
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var isTemporaryChat: Bool = false
    var activeSubagents: [SubagentInfo] = []
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    var subagentDetailStore: SubagentDetailStore?
    var resolveDaemonPort: (() -> Int?) = { nil }
    var isHistoryLoaded: Bool = true
    var dismissedDocumentSurfaceIds: Set<String> = []
    var onDismissDocumentWidget: ((String) -> Void)?
    var isMemoryDegraded: Bool = false
    var memoryDegradedReason: String? = nil
    var connectionDiagnosticHint: String? = nil
    var threadId: UUID?

    @State private var isNearBottom = true
    @State private var isDropTargeted = false
    @State private var editorContentHeight: CGFloat = 20
    @State private var isComposerExpanded = false

    private var isEmptyState: Bool {
        messages.isEmpty && isHistoryLoaded
    }

    private let composerMinHeight: CGFloat = 34

    /// Height reserved at the bottom of the scroll view so the last message isn't hidden behind the composer.
    private var composerReservedHeight: CGFloat {
        let editorClamped = min(max(editorContentHeight, 34), 200)
        let contentHeight = max(editorClamped, 34)
        let expanded = isComposerExpanded
        let topPad: CGFloat = expanded ? VSpacing.md : VSpacing.sm
        let bottomPad: CGFloat = expanded ? VSpacing.sm : VSpacing.sm
        let buttonRow: CGFloat = expanded ? 34 + VSpacing.xs : 0
        let base: CGFloat = VSpacing.sm + topPad + bottomPad + contentHeight + buttonRow
        let attachments: CGFloat = pendingAttachments.isEmpty ? 0 : 48
        let error: CGFloat = (sessionError == nil && errorText != nil) ? 36 : 0
        let sessionErrorToast: CGFloat = sessionError != nil ? 52 : 0
        return base + attachments + error + sessionErrorToast
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                if !hasAPIKey {
                    APIKeyBanner(onOpenSettings: onOpenSettings)
                }
                if isMemoryDegraded {
                    MemoryDegradedBanner(reason: memoryDegradedReason)
                }
                if messages.isEmpty && !isHistoryLoaded {
                    Spacer()
                    HStack {
                        Spacer()
                        ProgressView()
                            .controlSize(.small)
                        Spacer()
                    }
                    Spacer()
                } else if isEmptyState {
                    if isTemporaryChat {
                        ChatTemporaryChatEmptyStateView(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            isLoadingAttachment: isLoadingAttachment,
                            errorText: errorText,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onMicrophoneToggle: onMicrophoneToggle,
                            onDismissError: onDismissError,
                            editorContentHeight: $editorContentHeight,
                            isComposerExpanded: $isComposerExpanded
                        )
                    } else {
                        ChatEmptyStateView(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            isLoadingAttachment: isLoadingAttachment,
                            errorText: errorText,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onMicrophoneToggle: onMicrophoneToggle,
                            onDismissError: onDismissError,
                            editorContentHeight: $editorContentHeight,
                            isComposerExpanded: $isComposerExpanded
                        )
                    }
                } else {
                    ZStack(alignment: .bottom) {
                        MessageListView(
                            messages: messages,
                            isSending: isSending,
                            isThinking: isThinking,
                            selectedModel: selectedModel,
                            configuredProviders: configuredProviders,
                            activeSubagents: activeSubagents,
                            dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                            onConfirmationAllow: onConfirmationAllow,
                            onConfirmationDeny: onConfirmationDeny,
                            onAlwaysAllow: onAlwaysAllow,
                            onSurfaceAction: onSurfaceAction,
                            onDismissDocumentWidget: onDismissDocumentWidget,
                            onReportMessage: onReportMessage,
                            mediaEmbedSettings: mediaEmbedSettings,
                            resolveDaemonPort: resolveDaemonPort,
                            onModelPickerSelect: onModelPickerSelect,
                            onAbortSubagent: onAbortSubagent,
                            onSubagentTap: onSubagentTap,
                            subagentDetailStore: subagentDetailStore,
                            threadId: threadId,
                            isNearBottom: $isNearBottom
                        )
                        .safeAreaInset(edge: .bottom) {
                            Color.clear.frame(height: composerReservedHeight)
                                .animation(VAnimation.fast, value: editorContentHeight)
                        }

                        ComposerSection(
                            inputText: $inputText,
                            hasAPIKey: hasAPIKey,
                            isSending: isSending,
                            isRecording: isRecording,
                            suggestion: suggestion,
                            pendingAttachments: pendingAttachments,
                            isLoadingAttachment: isLoadingAttachment,
                            errorText: errorText,
                            sessionError: sessionError,
                            isSecretBlockError: isSecretBlockError,
                            onSendAnyway: onSendAnyway,
                            isRetryableError: isRetryableError,
                            onRetryError: onRetryError,
                            isConnectionError: isConnectionError,
                            hasRetryPayload: hasRetryPayload,
                            connectionDiagnosticHint: connectionDiagnosticHint,
                            onSend: onSend,
                            onStop: onStop,
                            onAcceptSuggestion: onAcceptSuggestion,
                            onAttach: onAttach,
                            onRemoveAttachment: onRemoveAttachment,
                            onPaste: onPaste,
                            onMicrophoneToggle: onMicrophoneToggle,
                            onDismissError: onDismissError,
                            onRetrySessionError: onRetry,
                            onCopyDebugInfo: onCopyDebugInfo,
                            onDismissSessionError: onDismissSessionError,
                            watchSession: watchSession,
                            onStopWatch: onStopWatch,
                            isLearnMode: isLearnMode,
                            networkEntryCount: networkEntryCount,
                            idleHint: idleHint,
                            editorContentHeight: $editorContentHeight,
                            isComposerExpanded: $isComposerExpanded
                        )
                    }
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
        .onChange(of: inputText) {
            // Reset composer height when input is cleared
            if inputText.isEmpty {
                editorContentHeight = composerMinHeight
            }
        }
    }

    @Environment(\.colorScheme) private var colorScheme

    @ViewBuilder
    private var chatBackground: some View {
        EmptyView()
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
}

// MARK: - Scroll Wheel Detection

/// Detects user-initiated scroll events scoped to the chat scroll view.
/// Fires `onScrollUp` when the user scrolls toward older content (untethers auto-scroll),
/// and `onScrollToBottom` when the user manually scrolls back to the bottom (re-tethers).
struct ScrollWheelDetector: NSViewRepresentable {
    let onScrollUp: () -> Void
    let onScrollToBottom: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let coordinator = context.coordinator
        coordinator.view = view
        coordinator.onScrollUp = onScrollUp
        coordinator.onScrollToBottom = onScrollToBottom
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            // Only process events within this view's bounds (scoped to the chat scroll area)
            guard let view = coordinator.view,
                  let window = view.window,
                  event.window == window else { return event }
            let locationInView = view.convert(event.locationInWindow, from: nil)
            guard view.bounds.width > 0, view.bounds.contains(locationInView) else { return event }

            if event.scrollingDeltaY > 3 && event.momentumPhase.isEmpty {
                // Direct user scroll up (toward older content) — untether,
                // but only if actually scrolled away from the bottom.
                // Momentum events are excluded so a flick doesn't accidentally untether.
                // Deferred to next run-loop tick so clipBounds reflects the post-scroll position;
                // reading it synchronously in the event monitor sees the pre-scroll state.
                DispatchQueue.main.async {
                    if let scrollView = coordinator.findEnclosingScrollView() {
                        let clipBounds = scrollView.contentView.bounds
                        let docHeight = scrollView.documentView?.frame.height ?? 0
                        if docHeight - clipBounds.maxY >= 50 {
                            coordinator.onScrollUp?()
                        }
                    } else {
                        coordinator.onScrollUp?()
                    }
                }
            } else if event.scrollingDeltaY < -1 {
                // Scrolling down (direct or momentum) — re-tether if at bottom.
                // Deferred to next run-loop tick so clipBounds reflects the post-scroll position;
                // reading it synchronously in the event monitor sees the pre-scroll state.
                DispatchQueue.main.async {
                    if let scrollView = coordinator.findEnclosingScrollView() {
                        let clipBounds = scrollView.contentView.bounds
                        let docHeight = scrollView.documentView?.frame.height ?? 0
                        if docHeight - clipBounds.maxY < 50 {
                            coordinator.onScrollToBottom?()
                        }
                    }
                }
            }
            return event
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onScrollUp = onScrollUp
        context.coordinator.onScrollToBottom = onScrollToBottom
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    class Coordinator {
        weak var view: NSView?
        var onScrollUp: (() -> Void)?
        var onScrollToBottom: (() -> Void)?
        var monitor: Any?

        func findEnclosingScrollView() -> NSScrollView? {
            var current = view?.superview
            while let v = current {
                if let sv = v as? NSScrollView { return sv }
                current = v.superview
            }
            return nil
        }
    }
}

// MARK: - Scroll Wheel Passthrough

/// Forwards scroll-wheel events to the chat's NSScrollView so that overlaid
/// controls (like the "Scroll to latest" pill) don't swallow trackpad/mouse-wheel input.
struct ScrollWheelPassthrough: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let coordinator = context.coordinator
        coordinator.view = view
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            guard let v = coordinator.view,
                  let window = v.window,
                  event.window == window else { return event }
            let location = v.convert(event.locationInWindow, from: nil)
            guard v.bounds.width > 0, v.bounds.contains(location) else { return event }

            if let scrollView = coordinator.findScrollView(for: event) {
                scrollView.scrollWheel(with: event)
                return nil // consume — we already forwarded it; prevents double-delivery
            }
            return event
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor {
            NSEvent.removeMonitor(monitor)
        }
    }

    class Coordinator {
        weak var view: NSView?
        var monitor: Any?

        /// Finds the deepest NSScrollView whose frame contains the event point.
        /// This ensures we forward to the chat scroll view, not the sidebar.
        func findScrollView(for event: NSEvent) -> NSScrollView? {
            guard let contentView = view?.window?.contentView else { return nil }
            return Self.deepestScrollView(in: contentView, containing: event.locationInWindow)
        }

        private static func deepestScrollView(in view: NSView, containing windowPoint: NSPoint) -> NSScrollView? {
            let localPoint = view.convert(windowPoint, from: nil)
            guard view.bounds.contains(localPoint) else { return nil }

            for sub in view.subviews.reversed() {
                if let sv = deepestScrollView(in: sub, containing: windowPoint) {
                    return sv
                }
            }

            if let sv = view as? NSScrollView { return sv }
            return nil
        }
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
                isRetryableError: false,
                onRetryError: {},
                isConnectionError: false,
                isSecretBlockError: false,
                onSendAnyway: {},
                onAcceptSuggestion: {},
                onAttach: {},
                onRemoveAttachment: { _ in },
                onDropFiles: { _ in },
                onDropImageData: { _, _ in },
                onPaste: {},
                onMicrophoneToggle: {},
                onConfirmationAllow: { _ in },
                onConfirmationDeny: { _ in },
                onAlwaysAllow: { _, _, _, _ in },
                onSurfaceAction: { _, _, _ in },
                sessionError: nil,
                onRetry: {},
                onDismissSessionError: {},
                onCopyDebugInfo: {},
                watchSession: nil,
                onStopWatch: {}
            )
        }
    }
}
#endif
