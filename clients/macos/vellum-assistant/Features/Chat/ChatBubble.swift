import SwiftUI
import VellumAssistantShared

// MARK: - Chat Bubble

struct ChatBubble: View {
    let message: ChatMessage
    /// When true, tool call chips are suppressed because a nearby message has inline surfaces.
    let hideToolCalls: Bool
    /// Decided confirmation from the next message, rendered as a compact chip at the bottom.
    let decidedConfirmation: ToolConfirmationData?
    let onSurfaceAction: (String, String, [String: AnyCodable]?) -> Void
    let onDismissDocumentWidget: (String) -> Void
    let dismissedDocumentSurfaceIds: Set<String>
    var onReportMessage: ((String?) -> Void)?
    var mediaEmbedSettings: MediaEmbedResolverSettings?
    var daemonHttpPort: Int?

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var isHovered = false

    @State private var showCopyConfirmation = false
    @State private var copyConfirmationTimer: DispatchWorkItem?
    @State private var mediaEmbedIntents: [MediaEmbedIntent] = []
    @State private var stepsExpanded = false
    @ObservedObject private var taskProgressOverlay = TaskProgressOverlayManager.shared

    private var isUser: Bool { message.role == .user }
    private var canReportMessage: Bool {
        !isUser && onReportMessage != nil
    }
    private var hasCopyableText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var hasOverflowActions: Bool {
        hasCopyableText || canReportMessage
    }
    private var showOverflowMenu: Bool {
        hasOverflowActions && (isHovered || showCopyConfirmation)
    }

    /// Composite identity for the `.task` modifier so it re-runs when either
    /// the message text or the embed settings change.
    /// Returns a stable value while the message is streaming to avoid
    /// cancelling and relaunching the async media embed resolution
    /// (NSDataDetector + regex + HTTP HEAD probes) on every token delta.
    private var mediaEmbedTaskID: String {
        if message.isStreaming { return "streaming-\(message.id)" }
        let s = mediaEmbedSettings
        return "\(message.text)|\(s?.enabled ?? false)|\(s?.enabledSince?.timeIntervalSince1970 ?? 0)|\(s?.allowedDomains ?? [])"
    }

    private var bubbleFill: AnyShapeStyle {
        if isUser {
            AnyShapeStyle(VColor.userBubble)
        } else if message.isError {
            AnyShapeStyle(VColor.error.opacity(0.1))
        } else {
            AnyShapeStyle(VColor.surface)
        }
    }

    @ViewBuilder
    private var bubbleBorderOverlay: some View {
        if message.isError {
            RoundedRectangle(cornerRadius: VRadius.lg)
                .strokeBorder(VColor.error.opacity(0.3), lineWidth: 1)
        } else if !isUser {
            RoundedRectangle(cornerRadius: VRadius.lg)
                .strokeBorder(VColor.surfaceBorder.opacity(0.85), lineWidth: 0.5)
        }
    }

    private func bubbleChrome<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(bubbleFill)
            )
            .overlay {
                bubbleBorderOverlay
            }
            .frame(maxWidth: 520, alignment: isUser ? .trailing : .leading)
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
        // Filter out the surface shown in the floating overlay
        let visibleSurfaces = message.inlineSurfaces.filter { $0.id != taskProgressOverlay.activeSurfaceId }
        if !visibleSurfaces.isEmpty {
            // Show bubble text when all visible surfaces are completed (collapsed to chips)
            let allCompleted = visibleSurfaces.allSatisfy { $0.completionState != nil }
            if !allCompleted { return false }
        }
        return hasText || !message.attachments.isEmpty
    }

    var body: some View {
        // Outer HStack: Spacer pushes the content group to the correct side.
        HStack(alignment: .top, spacing: 0) {
            if isUser { Spacer(minLength: 0) }

            // Inner HStack: avatar/button and bubble are grouped so the button
            // is always immediately adjacent to the bubble, not the screen edge.
            HStack(alignment: .top, spacing: VSpacing.sm) {
                if !isUser {
                    Image(nsImage: appearance.chatAvatarImage)
                        .interpolation(.none)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 28, height: 28)
                        .clipShape(Circle())
                        .padding(.top, 2)
                }

                if isUser && hasOverflowActions {
                    overflowMenuButton
                        .opacity(showOverflowMenu ? 1 : 0)
                        .animation(VAnimation.fast, value: showOverflowMenu)
                }

                VStack(alignment: isUser ? .trailing : .leading, spacing: VSpacing.sm) {
                    if !isUser && hasInterleavedContent {
                        interleavedContent
                    } else {
                        if shouldShowBubble {
                            bubbleContent
                        }

                        // Inline surfaces render below the bubble as full-width cards
                        // Skip surfaces that are currently shown in the floating overlay
                        if !message.inlineSurfaces.isEmpty {
                            ForEach(message.inlineSurfaces.filter { $0.id != taskProgressOverlay.activeSurfaceId }) { surface in
                                InlineSurfaceRouter(surface: surface, onAction: onSurfaceAction)
                            }
                        }

                        // Document widget for document_create tool calls
                        if let documentToolCall = message.toolCalls.first(where: { $0.toolName == "document_create" && $0.isComplete }) {
                            documentWidget(for: documentToolCall)
                        }
                    }

                    // Media embeds rendered below the text, preserving source order
                    ForEach(mediaEmbedIntents.indices, id: \.self) { idx in
                        switch mediaEmbedIntents[idx] {
                        case .image(let url):
                            InlineImageEmbedView(url: url)
                        case .video(let provider, let videoID, let embedURL):
                            InlineVideoEmbedCard(provider: provider, videoID: videoID, embedURL: embedURL)
                        }
                    }

                    // Single unified status area at the bottom of the message:
                    // - In-progress: shows "Running a terminal command ..."
                    // - Complete: shows compact chips ("Ran a terminal command" + "Permission granted")
                    // Skip completed tool chips when already rendered inline via interleaved content.
                    if !isUser && !(hasInterleavedContent && allToolCallsComplete) {
                        trailingStatus
                    }
                }
                // Prevent LazyVStack from compressing the bubble height, which causes the
                // trailing tool-chip to overlap long text content.
                .fixedSize(horizontal: false, vertical: true)
                .contextMenu {}

                if !isUser && hasOverflowActions {
                    overflowMenuButton
                        .opacity(showOverflowMenu ? 1 : 0)
                        .animation(VAnimation.fast, value: showOverflowMenu)
                }
            }

            if !isUser { Spacer(minLength: 0) }
        }
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
        .task(id: mediaEmbedTaskID) {
            guard !message.isStreaming else { return }
            guard let settings = mediaEmbedSettings else {
                mediaEmbedIntents = []
                return
            }
            let resolved = await MediaEmbedResolver.resolve(message: message, settings: settings)
            guard !Task.isCancelled else { return }
            mediaEmbedIntents = resolved
        }
    }

    // MARK: - Compact trailing chips (tool calls + permission)

    /// Whether all tool calls are complete and the message is done streaming.
    private var allToolCallsComplete: Bool {
        !message.toolCalls.isEmpty && message.toolCalls.allSatisfy { $0.isComplete } && !message.isStreaming
    }

    private func copyMessageText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
        copyConfirmationTimer?.cancel()
        showCopyConfirmation = true
        let timer = DispatchWorkItem { showCopyConfirmation = false }
        copyConfirmationTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timer)
    }

    private var overflowMenuButton: some View {
        Menu {
            if hasCopyableText {
                Button("Copy message") {
                    copyMessageText()
                }
            }
            if let onReportMessage, !isUser {
                Button("Export response for diagnostics") {
                    onReportMessage(message.daemonMessageId)
                }
            }
        } label: {
            Image(systemName: showCopyConfirmation ? "checkmark" : "ellipsis")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(showCopyConfirmation ? VColor.success : VColor.textMuted)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .tint(showCopyConfirmation ? VColor.success : VColor.textMuted)
        .frame(width: 24, height: 24)
        .accessibilityLabel("Message actions")
        .animation(VAnimation.fast, value: showCopyConfirmation)
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
        let hasStreamingCode = message.isStreaming && message.streamingCodePreview != nil && !(message.streamingCodePreview?.isEmpty ?? true)

        if hasStreamingCode {
            let rawName = message.streamingCodeToolName ?? ""
            let activeBuildingStatus = message.toolCalls.last(where: { !$0.isComplete })?.buildingStatus
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                RunningIndicator(
                    label: Self.friendlyRunningLabel(rawName, buildingStatus: activeBuildingStatus),
                    onTap: nil
                )
                CodePreviewView(code: message.streamingCodePreview!)
            }
            .frame(maxWidth: 520, alignment: .leading)
        } else if hasActuallyRunningTool && !permissionWasDenied {
            // In progress — show running indicator or claude_code progress view
            let current = message.toolCalls.first(where: { !$0.isComplete })!
            if current.toolName == "claude_code" && !current.claudeCodeSteps.isEmpty {
                ClaudeCodeProgressView(steps: current.claudeCodeSteps, isRunning: true)
                    .frame(maxWidth: 520, alignment: .leading)
            } else {
                let progressive = current.buildingStatus != nil ? [] : Self.progressiveLabels(for: current.toolName)
                RunningIndicator(
                    label: Self.friendlyRunningLabel(current.toolName, inputSummary: current.inputSummary, buildingStatus: current.buildingStatus),
                    progressiveLabels: progressive,
                    labelInterval: progressive.isEmpty ? 6 : 15,
                    onTap: nil
                )
                    .frame(maxWidth: 520, alignment: .leading)
            }
        } else if toolsCompleteButStillStreaming && !permissionWasDenied {
            // All tools done but model is still working (generating next tool call)
            RunningIndicator(
                label: "Thinking",
                progressiveLabels: ["Thinking", "Figuring out next steps", "Almost ready"],
                labelInterval: 8,
                onTap: nil
            )
                .frame(maxWidth: 520, alignment: .leading)
        } else if hasCompletedTools || hasPermission || (hasInProgressTools && permissionWasDenied) {
            // All done (or denied) — steps pill + permission chip on one row,
            // with the expanded steps list in the row below.
            let onlyPermissionTools = message.toolCalls.allSatisfy { $0.toolName == "request_system_permission" }
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: VSpacing.sm) {
                    if hasCompletedTools && !(onlyPermissionTools && decidedConfirmation != nil) {
                        UsedToolsList(toolCalls: message.toolCalls, isExpanded: $stepsExpanded)
                    } else if hasInProgressTools && permissionWasDenied {
                        compactFailedToolChip
                    }
                    if let confirmation = decidedConfirmation {
                        compactPermissionChip(confirmation)
                    }
                    Spacer()
                }

                if stepsExpanded && hasCompletedTools {
                    StepsSection(toolCalls: message.toolCalls)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .animation(VAnimation.fast, value: stepsExpanded)
            .padding(.top, VSpacing.xxs)
        }
    }

    /// Maps tool names to user-friendly past-tense labels.
    /// When `inputSummary` is provided, produces contextual labels like "Read config.json".
    static func friendlyToolLabel(_ toolName: String, inputSummary: String = "") -> String {
        let name = toolName.lowercased()
        let summary = inputSummary
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)

        // Extract just the filename from a file path.
        let fileName: String? = {
            guard !summary.isEmpty else { return nil }
            let last = (summary as NSString).lastPathComponent
            guard !last.isEmpty, last != "." else { return nil }
            return last
        }()

        switch name {
        case "run command":
            if !summary.isEmpty {
                let display = summary.count > 30 ? String(summary.prefix(27)) + "..." : summary
                return "Ran `\(display)`"
            }
            return "Ran a command"
        case "read file":
            if let f = fileName { return "Read \(f)" }
            return "Read a file"
        case "write file":
            if let f = fileName { return "Wrote \(f)" }
            return "Wrote a file"
        case "edit file":
            if let f = fileName { return "Edited \(f)" }
            return "Edited a file"
        case "search files":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched for '\(display)'"
            }
            return "Searched files"
        case "find files":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched for \(display)"
            }
            return "Found files"
        case "web search":
            if !summary.isEmpty {
                let display = summary.count > 25 ? String(summary.prefix(22)) + "..." : summary
                return "Searched '\(display)'"
            }
            return "Searched the web"
        case "fetch url":              return "Fetched a webpage"
        case "browser navigate":       return "Opened a page"
        case "browser click":          return "Clicked on the page"
        case "browser screenshot":     return "Took a screenshot"
        case "request system permission":
            return "\(Self.permissionFriendlyName(from: summary)) granted"
        default:                       return "Used \(toolName)"
        }
    }

    /// Plural past-tense labels for multiple tool calls of the same type.
    static func friendlyToolLabelPlural(_ toolName: String, count: Int) -> String {
        switch toolName.lowercased() {
        case "run command":        return "Ran \(count) commands"
        case "read file":          return "Read \(count) files"
        case "write file":         return "Wrote \(count) files"
        case "edit file":          return "Edited \(count) files"
        case "search files":       return "Ran \(count) searches"
        case "find files":         return "Ran \(count) searches"
        case "web search":         return "Searched the web \(count) times"
        case "fetch url":          return "Fetched \(count) webpages"
        case "browser navigate":   return "Opened \(count) pages"
        case "browser click":      return "Clicked \(count) times"
        case "browser screenshot":  return "Took \(count) screenshots"
        default:                   return "Used \(toolName) \(count) times"
        }
    }

    /// Maps tool names to user-friendly present-tense labels for the running state.
    static func friendlyRunningLabel(_ toolName: String, inputSummary: String? = nil, buildingStatus: String? = nil) -> String {
        // For app file tools, prefer the descriptive building status from tool input
        if let status = buildingStatus {
            if toolName == "app_file_edit" || toolName == "app_file_write" || toolName == "app_create" || toolName == "app_update" {
                return status
            }
        }
        switch toolName {
        case "bash", "host_bash":               return "Running a command"
        case "file_read", "host_file_read":     return "Reading a file"
        case "file_write", "host_file_write":   return "Writing a file"
        case "file_edit", "host_file_edit":     return "Editing a file"
        case "grep":                            return "Searching files"
        case "glob":                            return "Finding files"
        case "web_search":                      return "Searching the web"
        case "web_fetch":                       return "Fetching a webpage"
        case "browser_navigate":                return "Opening a page"
        case "browser_click":                   return "Clicking on the page"
        case "browser_screenshot":              return "Taking a screenshot"
        case "app_create":                      return "Building your app"
        case "app_update":                      return "Updating your app"
        case "skill_load":
            if let name = inputSummary, !name.isEmpty {
                let display = name.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
                return "Loading \(display)"
            }
            return "Loading a skill"
        default:
            // Convert raw snake_case name to a readable fallback
            let display = toolName.replacingOccurrences(of: "_", with: " ")
            return "Running \(display)"
        }
    }

    /// Progressive labels for long-running tools. Cycles through these over time.
    static func progressiveLabels(for toolName: String) -> [String] {
        switch toolName {
        case "app_create":
            return [
                "Choosing a visual direction",
                "Designing the layout",
                "Writing the interface",
                "Adding styles and colors",
                "Wiring up interactions",
                "Polishing the details",
                "Almost there",
            ]
        case "app_update":
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
    static func friendlyToolIcon(_ toolName: String) -> String {
        switch toolName {
        case "bash", "host_bash":                               return "terminal"
        case "file_read", "host_file_read":                     return "doc.text"
        case "file_write", "host_file_write":                   return "doc.badge.plus"
        case "file_edit", "host_file_edit":                     return "pencil"
        case "grep", "glob", "web_search":                      return "magnifyingglass"
        case "web_fetch":                                       return "globe"
        case "browser_navigate", "browser_click":               return "safari"
        case "browser_screenshot":                              return "camera"
        case "request_system_permission":                       return "lock.shield"
        default:                                                return "gearshape"
        }
    }

    /// Convert raw permission_type (e.g. "full_disk_access") to a user-facing label.
    static func permissionFriendlyName(from rawType: String) -> String {
        switch rawType {
        case "full_disk_access": return "Full Disk Access"
        case "accessibility": return "Accessibility"
        case "screen_recording": return "Screen Recording"
        case "calendar": return "Calendar"
        case "contacts": return "Contacts"
        case "photos": return "Photos"
        case "location": return "Location Services"
        case "microphone": return "Microphone"
        case "camera": return "Camera"
        default:
            if rawType.isEmpty { return "Permission" }
            return rawType.replacingOccurrences(of: "_", with: " ").capitalized
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

            Text(isApproved ? "\(confirmation.toolCategory) allowed" :
                 confirmation.state == .denied ? "\(confirmation.toolCategory) denied" : "Timed out")
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
            case .toolCalls(let indices):
                let calls = indices.compactMap { i in
                    i < message.toolCalls.count ? message.toolCalls[i] : nil
                }
                if !calls.isEmpty && calls.allSatisfy({ $0.isComplete }) && !hideToolCalls {
                    VStack(alignment: .leading, spacing: 0) {
                        UsedToolsList(toolCalls: calls, isExpanded: $stepsExpanded)
                        if stepsExpanded {
                            StepsSection(toolCalls: calls)
                                .transition(.opacity.combined(with: .move(edge: .top)))
                        }
                    }
                    .animation(VAnimation.fast, value: stepsExpanded)
                    .padding(.top, VSpacing.xxs)
                }
            case .surface(let i):
                if i < message.inlineSurfaces.count,
                   message.inlineSurfaces[i].id != taskProgressOverlay.activeSurfaceId {
                    InlineSurfaceRouter(surface: message.inlineSurfaces[i], onAction: onSurfaceAction)
                }
            }
        }

        // Attachments are not part of contentOrder but must still be rendered
        let partitioned = partitionedAttachments
        if !partitioned.images.isEmpty {
            attachmentImageGrid(partitioned.images)
        }
        if !partitioned.videos.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(partitioned.videos) { attachment in
                    InlineVideoAttachmentView(attachment: attachment, daemonHttpPort: daemonHttpPort)
                }
            }
        }
        if !partitioned.files.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(partitioned.files) { attachment in
                    fileAttachmentChip(attachment)
                }
            }
        }
    }

    /// Render a single text segment as a styled bubble, with table and image support.
    @ViewBuilder
    private func textBubble(for segmentText: String) -> some View {
        let segments = Self.cachedSegments(for: segmentText)
        let hasRichContent = segments.contains(where: {
            switch $0 {
            case .table, .image, .heading, .codeBlock, .horizontalRule, .list: return true
            case .text: return false
            }
        })

        bubbleChrome {
            if hasRichContent {
                MarkdownSegmentView(segments: segments)
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
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 520, alignment: .leading)
            }
        }
    }

    /// Current step indicator rendered outside the bubble.
    /// Shows only when there are actual tool calls.
    // Tool call status is rendered via trailingStatus at the bottom of the message.

    private var hasText: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var attachmentSummary: String {
        let count = message.attachments.count
        if count == 1 {
            return "Sent \(message.attachments[0].filename)"
        }
        return "Sent \(count) attachments"
    }

    /// Partitions attachments into decoded images, videos, and non-media files in a single pass,
    /// avoiding redundant base64 decoding and NSImage construction across render calls.
    private var partitionedAttachments: (images: [(ChatAttachment, NSImage)], videos: [ChatAttachment], files: [ChatAttachment]) {
        var images: [(ChatAttachment, NSImage)] = []
        var videos: [ChatAttachment] = []
        var files: [ChatAttachment] = []
        for attachment in message.attachments {
            if attachment.mimeType.hasPrefix("image/"), let img = nsImage(for: attachment) {
                images.append((attachment, img))
            } else if attachment.mimeType.hasPrefix("video/") {
                videos.append(attachment)
            } else {
                files.append(attachment)
            }
        }
        return (images, videos, files)
    }

    private var bubbleContent: some View {
        let partitioned = partitionedAttachments
        return bubbleChrome {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let skillInvocation = message.skillInvocation {
                    SkillInvocationChip(data: skillInvocation)
                }

                if message.isError && hasText {
                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(VColor.error)
                            .padding(.top, 1)
                        Text(message.text)
                            .font(.system(size: 13))
                            .foregroundColor(VColor.textPrimary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if hasText {
                    let segments = Self.cachedSegments(for: message.text)
                    let hasRichContent = segments.contains(where: {
                        switch $0 {
                        case .table, .image, .heading, .codeBlock, .horizontalRule, .list: return true
                        case .text: return false
                        }
                    })
                    VStack(alignment: .leading, spacing: hasRichContent ? VSpacing.lg : VSpacing.xs) {

                        if hasRichContent {
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
                                case .image(let alt, let url):
                                    AnimatedImageView(urlString: url)
                                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                                        .accessibilityLabel(alt.isEmpty ? "Image" : alt)
                                case .heading(let level, let headingText):
                                    let font: Font = switch level {
                                    case 1: .system(size: 20, weight: .bold)
                                    case 2: .system(size: 17, weight: .semibold)
                                    case 3: .system(size: 14, weight: .semibold)
                                    default: .system(size: 13, weight: .semibold)
                                    }
                                    Text(headingText)
                                        .font(font)
                                        .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                        .textSelection(.enabled)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(.top, level == 1 ? VSpacing.xs : 0)

                                case .codeBlock(let language, let code):
                                    VStack(alignment: .leading, spacing: 0) {
                                        if let language, !language.isEmpty {
                                            Text(language)
                                                .font(.system(size: 11, weight: .medium))
                                                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textMuted)
                                                .padding(.horizontal, VSpacing.sm)
                                                .padding(.top, VSpacing.xs)
                                        }
                                        ScrollView(.horizontal, showsIndicators: false) {
                                            Text(code)
                                                .font(VFont.mono)
                                                .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                                .textSelection(.enabled)
                                                .fixedSize(horizontal: true, vertical: true)
                                                .padding(VSpacing.sm)
                                        }
                                    }
                                    .background(isUser ? VColor.userBubbleText.opacity(0.1) : VColor.backgroundSubtle)
                                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                                case .horizontalRule:
                                    Rectangle()
                                        .fill(isUser ? VColor.userBubbleText.opacity(0.3) : VColor.surfaceBorder)
                                        .frame(height: 1)
                                        .padding(.vertical, VSpacing.xs)

                                case .list(let items):
                                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                            let prefix = item.ordered ? "\(item.number). " : "\u{2022} "
                                            let indentLevel = item.indent / 2
                                            HStack(alignment: .top, spacing: 0) {
                                                Text(prefix)
                                                    .font(.system(size: 13))
                                                    .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)
                                                let options = AttributedString.MarkdownParsingOptions(
                                                    interpretedSyntax: .inlineOnlyPreservingWhitespace
                                                )
                                                let attributed = (try? AttributedString(markdown: item.text, options: options))
                                                    ?? AttributedString(item.text)
                                                Text(attributed)
                                                    .font(.system(size: 13))
                                                    .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                                                    .tint(isUser ? VColor.userBubbleText : VColor.accent)
                                                    .textSelection(.enabled)
                                                    .fixedSize(horizontal: false, vertical: true)
                                            }
                                            .padding(.leading, CGFloat(indentLevel) * 16)
                                        }
                                    }
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
                    }
                } else if !message.attachments.isEmpty {
                    Text(attachmentSummary)
                        .font(VFont.caption)
                        .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)
                }

                if !partitioned.images.isEmpty {
                    attachmentImageGrid(partitioned.images)
                }

                if !partitioned.videos.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        ForEach(partitioned.videos) { attachment in
                            InlineVideoAttachmentView(attachment: attachment, daemonHttpPort: daemonHttpPort)
                        }
                    }
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
        }
    }

    @ViewBuilder
    private func documentWidget(for toolCall: ToolCallData) -> some View {
        let parsed = DocumentResultParser.parse(from: toolCall)

        if let surfaceId = parsed.surfaceId, !dismissedDocumentSurfaceIds.contains(surfaceId) {
            DocumentReopenWidget(
                documentTitle: parsed.title,
                onReopen: {
                    NotificationCenter.default.post(
                        name: .openDocumentEditor,
                        object: nil,
                        userInfo: ["documentSurfaceId": surfaceId]
                    )
                },
                onDismiss: {
                    onDismissDocumentWidget(surfaceId)
                }
            )
            .padding(.top, VSpacing.sm)
        }
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
        // Use pre-decoded thumbnail image — avoids NSImage(data:) during layout, which
        // can trigger re-entrant AppKit constraint invalidation and crash on scroll.
        if let img = attachment.thumbnailImage {
            return img
        }
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
        let sanitized = (attachment.filename as NSString).lastPathComponent
        let fileURL = tempDir.appendingPathComponent(sanitized.isEmpty ? "image" : sanitized)
        do {
            try data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        } catch {
            // Silently fail — not critical
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("video/") { return "film" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
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

    /// Cached markdown segment parser to avoid re-parsing on every render.
    private static var segmentCache = [Int: [MarkdownSegment]]()

    private static func cachedSegments(for text: String) -> [MarkdownSegment] {
        let key = text.hashValue
        if let cached = segmentCache[key] { return cached }
        let result = parseMarkdownSegments(text)
        if segmentCache.count >= maxCacheSize {
            if let first = segmentCache.keys.first { segmentCache.removeValue(forKey: first) }
        }
        segmentCache[key] = result
        return result
    }

    /// Cached markdown parser to avoid re-parsing on every render.
    /// Uses the message text hash as the cache key.
    private static var markdownCache = [Int: AttributedString]()
    private static let maxCacheSize = 100

    private var markdownText: AttributedString {
        let textToRender = message.text
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
        var parsed = (try? AttributedString(markdown: trimmed, options: options))
            ?? AttributedString(trimmed)

        // Highlight slash command token (e.g. /model) in blue
        if let slashMatch = trimmed.range(of: #"^/\w+"#, options: .regularExpression) {
            let offset = trimmed.distance(from: trimmed.startIndex, to: slashMatch.lowerBound)
            let length = trimmed.distance(from: slashMatch.lowerBound, to: slashMatch.upperBound)
            let attrStart = parsed.index(parsed.startIndex, offsetByCharacters: offset)
            let attrEnd = parsed.index(attrStart, offsetByCharacters: length)
            parsed[attrStart..<attrEnd].foregroundColor = adaptiveColor(light: Sage._500, dark: Sage._300)
        }

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

}
