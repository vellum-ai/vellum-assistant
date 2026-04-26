import SwiftUI

/// A horizontal progress bar that displays tool calls as clickable steps.
/// Each step can be expanded to show details like results and screenshots.
public struct ToolCallProgressBar: View {
    public let toolCalls: [ToolCallData]
    @State private var expandedStepId: UUID?
    /// Cached line count for the expanded tool call's result text — avoids O(n)
    /// byte scan on every SwiftUI render pass when a step is expanded.
    @State private var cachedResultLineCount: Int?

    public init(toolCalls: [ToolCallData]) {
        self.toolCalls = toolCalls
    }

    /// The most relevant tool call to label: the first incomplete one, or the
    /// last one if all are complete (same heuristic as CurrentStepIndicator).
    private var representativeToolCall: ToolCallData? {
        toolCalls.first(where: { !$0.isComplete }) ?? toolCalls.last
    }

    /// When this progress bar contains exactly one `acp_spawn` tool call
    /// whose result carries a parseable `acpSessionId`, render the inline
    /// tap-to-open card instead of the standard step bar. The card opens
    /// the Coding Agents detail view for that session — mirrors the macOS
    /// `acp_spawn` row in `AssistantProgressView.swift`. We restrict to
    /// the single-call case so a streaming progress bar that happens to
    /// include `acp_spawn` alongside other tools doesn't lose its
    /// step-by-step affordance.
    ///
    /// The card stays available for spawns in any state (running,
    /// completed, errored) so users can navigate into the detail view as
    /// soon as the session id is known — the live status indicator
    /// communicates state instead of forcing a fallback to the standard
    /// row. Returns `nil` when no `acpSessionId` can be extracted.
    private var acpSpawnDeepLink: (toolCall: ToolCallData, sessionId: String)? {
        guard toolCalls.count == 1,
              let toolCall = toolCalls.first,
              toolCall.toolName == "acp_spawn",
              let result = toolCall.result,
              !result.isEmpty,
              let sessionId = ToolCallProgressBar.extractAcpSessionId(from: result) else {
            return nil
        }
        return (toolCall, sessionId)
    }

    public var body: some View {
        #if os(iOS)
        if let deepLink = acpSpawnDeepLink {
            ACPSpawnDeepLinkCard(toolCall: deepLink.toolCall, acpSessionId: deepLink.sessionId)
        } else {
            standardBody
        }
        #else
        standardBody
        #endif
    }

    @ViewBuilder
    private var standardBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Progress bar with steps
            VStack(spacing: VSpacing.xs) {
                // Icons and lines row
                HStack(spacing: 0) {
                    ForEach(Array(toolCalls.enumerated()), id: \.element.id) { index, toolCall in
                        // Step circle
                        stepCircle(for: toolCall, index: index)

                        // Connector line (skip for last item)
                        if index < toolCalls.count - 1 {
                            connectorLine(isComplete: toolCall.isComplete)
                        }
                    }
                }

                // Summary label — shows the active/last tool name + progress count.
                // Replaces per-step fixed-width labels that truncated on narrow
                // iOS screens (LUM-1026).
                if let representative = representativeToolCall {
                    HStack(spacing: VSpacing.xs) {
                        Text(representative.friendlyName)
                            .font(VFont.labelSmall)
                            .foregroundStyle(stepTextColor(for: representative))
                            .lineLimit(1)

                        if toolCalls.count > 1 {
                            let completedCount = toolCalls.filter(\.isComplete).count
                            Text("(\(completedCount)/\(toolCalls.count))")
                                .font(VFont.labelSmall)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                    }
                }
            }
            .padding(.top, VSpacing.md)

            // Expanded details (shown when a step is clicked)
            if let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }) {
                expandedDetails(for: expandedCall)
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.95).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
        }
    }

    // MARK: - acp_spawn deep-link helpers

    /// Best-effort JSON probe for the `acpSessionId` field in
    /// `acp_spawn`'s result payload — the daemon UUID
    /// (``ACPSessionState/id``) the manager generated for the new
    /// session. That same UUID is what ``ACPSessionStore`` keys its
    /// `sessions` dictionary by, so the value flows straight into
    /// `store.sessions[id]` lookups without translation.
    ///
    /// The tool returns a JSON object on the first line and may append
    /// a free-form outdated-adapter warning after a blank line (see
    /// `assistant/src/tools/acp/spawn.ts`), so we parse the leading line
    /// rather than the full string — otherwise the appended diagnostic
    /// invalidates the JSON and the deep link would silently disappear
    /// in that case. On failure or any non-JSON shape we return `nil` so
    /// the caller falls back to the regular progress bar. Shared between
    /// iOS and macOS — macOS `ToolCallStepDetailRow.acpSessionIdToOpen`
    /// calls this helper so both platforms accept the same payload
    /// shapes from a single implementation.
    public static func extractAcpSessionId(from result: String) -> String? {
        let leading = result.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
            .first.map(String.init) ?? ""
        guard let data = leading.data(using: .utf8) else { return nil }
        let parsed = try? JSONSerialization.jsonObject(with: data)
        guard let dict = parsed as? [String: Any] else { return nil }
        guard let id = dict["acpSessionId"] as? String, !id.isEmpty else {
            return nil
        }
        return id
    }

    // MARK: - Step Circle

    @ViewBuilder
    private func stepCircle(for toolCall: ToolCallData, index: Int) -> some View {
        Button {
            withAnimation(VAnimation.fast) {
                // Toggle expansion when clicked
                if expandedStepId == toolCall.id {
                    expandedStepId = nil
                } else if toolCall.isComplete {
                    cachedResultLineCount = nil
                    expandedStepId = toolCall.id
                }
            }
        } label: {
            ZStack {
                if toolCall.isComplete {
                    // Filled circle for completed steps
                    Circle()
                        .fill(toolCall.isError ? VColor.systemNegativeStrong : VColor.primaryBase)
                        .frame(width: 20, height: 20)

                    if toolCall.isError {
                        // Error icon
                        VIconView(.x, size: 8)
                            .foregroundStyle(VColor.auxWhite)
                    } else {
                        // Checkmark
                        VIconView(.check, size: 8)
                            .foregroundStyle(VColor.auxWhite)
                    }
                } else {
                    // Outlined circle for in-progress
                    Circle()
                        .strokeBorder(VColor.primaryBase, lineWidth: 2)
                        .frame(width: 20, height: 20)

                    // Loading spinner inside
                    ProgressView()
                        .scaleEffect(0.35)
                        .tint(VColor.primaryBase)
                        .frame(width: 20, height: 20)
                }
            }
            .frame(width: 20, height: 20)
        }
        .frame(minWidth: 28, minHeight: 28)
        .contentShape(Circle())
        .buttonStyle(.plain)
        .disabled(!toolCall.isComplete)
        .accessibilityLabel(toolCall.isError ? "\(toolCall.friendlyName), failed" : toolCall.isComplete ? "\(toolCall.friendlyName), completed" : "\(toolCall.friendlyName), in progress")
    }

    // MARK: - Connector Line

    private func connectorLine(isComplete: Bool) -> some View {
        Rectangle()
            .fill(VColor.borderBase)
            .frame(width: 32, height: 2)
    }

    // MARK: - Expanded Details

    @ViewBuilder
    private func expandedDetails(for toolCall: ToolCallData) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Header
            HStack {
                VIconView(.terminal, size: 12)
                    .foregroundStyle(toolCall.isError ? VColor.systemNegativeStrong : VColor.primaryBase)

                Text(toolCall.friendlyName)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Spacer()

                Button {
                    withAnimation(VAnimation.fast) {
                        expandedStepId = nil
                    }
                } label: {
                    VIconView(.x, size: 10)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close details")
            }

            // Input summary
            if !toolCall.inputSummary.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Input")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    Text(toolCall.inputSummary)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .textSelection(.enabled)
                }
            }

            // Screenshots / generated images
            ForEach(Array(toolCall.cachedImages.enumerated()), id: \.offset) { _, cachedImage in
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Image")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    #if os(macOS)
                    HStack(spacing: 0) {
                        Image(nsImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        Spacer(minLength: 0)
                    }
                    #elseif os(iOS)
                    HStack(spacing: 0) {
                        Image(uiImage: cachedImage)
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        Spacer(minLength: 0)
                    }
                    #endif
                }
            }

            // Result
            if let result = toolCall.result {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Result")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    if let exitCode = ToolCallChip.parseExitCode(from: result) {
                        VStack(alignment: .leading, spacing: VSpacing.xxs) {
                            HStack(spacing: VSpacing.xs) {
                                VIconView(.triangleAlert, size: 11)
                                    .foregroundStyle(VColor.systemNegativeStrong)
                                Text("Exit code \(exitCode)")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.systemNegativeStrong)
                            }
                            if let explanation = ToolCallChip.exitCodeExplanation(exitCode) {
                                Text(explanation)
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                            }
                            let extraOutput = result
                                .replacingOccurrences(of: #"<command_exit code="\d+" />"#, with: "", options: .regularExpression)
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !extraOutput.isEmpty {
                                Text(extraOutput)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .textSelection(.enabled)
                            }
                        }
                    } else if result == "<command_completed />" {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 11)
                                .foregroundStyle(VColor.primaryBase)
                            Text("Command completed successfully (no output).")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                    } else {
                        ScrollView {
                            HStack(spacing: 0) {
                                Text(result)
                                    .font(VFont.bodySmallDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .textSelection(.enabled)
                                Spacer(minLength: 0)
                            }
                        }
                        .adaptiveScrollFrame(for: result, maxHeight: 200, lineThreshold: 12, lineCount: cachedResultLineCount)
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .onAppear {
            if cachedResultLineCount == nil,
               let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }),
               let result = expandedCall.result {
                cachedResultLineCount = ToolCallChip.countLines(in: result)
            }
        }
        .onChange(of: expandedStepId) {
            if let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }),
               let result = expandedCall.result {
                cachedResultLineCount = ToolCallChip.countLines(in: result)
            } else {
                cachedResultLineCount = nil
            }
        }
        .onChange(of: toolCalls.first(where: { $0.id == expandedStepId })?.resultLength) {
            if let expandedId = expandedStepId,
               let expandedCall = toolCalls.first(where: { $0.id == expandedId }),
               let result = expandedCall.result {
                cachedResultLineCount = ToolCallChip.countLines(in: result)
            } else {
                cachedResultLineCount = nil
            }
        }
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Colors

    private func stepTextColor(for toolCall: ToolCallData) -> Color {
        if toolCall.isError {
            return VColor.systemNegativeStrong
        } else if !toolCall.isComplete {
            return VColor.contentSecondary
        } else {
            return VColor.contentDefault
        }
    }
}

#if os(iOS)

/// Compact tap-to-open card replacing the standard step bar for
/// `acp_spawn` tool calls on iOS. Visually mirrors the macOS row in
/// `ToolCallStepDetailRow.acpSpawnDeepLinkRow` — a status-driven leading
/// glyph, the friendly tool name, and a chevron-right hint pointing at
/// "tap to navigate". Status updates live: if a spawn lands on the chat
/// before its session row finishes initializing, the indicator pulses
/// until the daemon reports a terminal state via SSE.
public struct ACPSpawnDeepLinkCard: View {
    public let toolCall: ToolCallData
    public let acpSessionId: String

    public init(toolCall: ToolCallData, acpSessionId: String) {
        self.toolCall = toolCall
        self.acpSessionId = acpSessionId
    }

    public var body: some View {
        Button {
            Self.openACPSession(id: acpSessionId)
        } label: {
            HStack(spacing: VSpacing.sm) {
                ACPSpawnStatusIndicatorView(
                    toolCall: toolCall,
                    acpSessionId: acpSessionId,
                    store: ACPSpawnAppDelegateBridge.shared?.acpSessionStore
                )
                .frame(width: 16, height: 16)
                VStack(alignment: .leading, spacing: 0) {
                    Text(ToolCallData.displaySafe(toolCall.friendlyName))
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(ACPSpawnDeepLinkCard.statusLabel(for: toolCall))
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
                Spacer(minLength: 0)
                VIconView(.chevronRight, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .contentShape(Rectangle())
            .padding(VSpacing.md)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .accessibilityLabel("\(ToolCallData.displaySafe(toolCall.friendlyName)). \(Self.statusLabel(for: toolCall)). Tap to open coding agent session.")
    }

    /// Short human-readable phase label used for both the secondary
    /// text under the title and the accessibility announcement.
    /// `static` so unit tests can exercise the mapping without
    /// spinning up a SwiftUI view tree.
    static func statusLabel(for toolCall: ToolCallData) -> String {
        if toolCall.isError {
            return "Failed"
        }
        if toolCall.isComplete {
            return "Completed"
        }
        return "Running"
    }

    /// Drive the deep link by stashing the requested id on the shared
    /// `ACPSessionStore` and asking `IOSRootNavigationView` to surface
    /// the Coding Agents sheet via the same store-observation hook.
    /// The store is resolved through ``ACPSpawnAppDelegateBridge``,
    /// which the iOS app delegate populates on launch — that indirection
    /// keeps `clients/shared/` free of any iOS-specific `AppDelegate`
    /// import.
    ///
    /// `static` so unit tests can exercise the side effects against an
    /// injected `ACPSessionStore` via
    /// ``applyACPSessionDeepLink(id:store:)``.
    static func openACPSession(id: String) {
        applyACPSessionDeepLink(id: id, store: ACPSpawnAppDelegateBridge.sharedStore)
    }

    /// Pure side-effect helper for ``openACPSession(id:)``. Setting the
    /// id triggers `IOSRootNavigationView`'s observer to flip
    /// `isACPSessionsPresented = true`; the sheet's `ACPSessionsView`
    /// then consumes the same field to push the matching detail view
    /// onto its `NavigationStack`. A nil store is a no-op so callers
    /// can pass through the bridge result without a guard of their own.
    @MainActor
    static func applyACPSessionDeepLink(id: String, store: ACPSessionStore?) {
        guard let store else { return }
        store.selectedSessionId = id
    }
}

/// Live status glyph for ``ACPSpawnDeepLinkCard``. Pulses while the
/// underlying spawn is still running, flips to a positive check on
/// success, a negative x on error, or a muted dash on cancellation.
///
/// Reads the matching ``ACPSessionViewModel`` off the supplied store —
/// because `ACPSessionStore` is `@Observable`, simply touching
/// `store.sessions[id]?.state.status` inside `body` enrolls this view
/// in SwiftUI's per-property observation graph, so a daemon SSE update
/// flips the glyph without a manual refresh. Mirrors the macOS
/// ``ACPSpawnStatusDot`` in `AssistantProgressView.swift` so both
/// platforms catch running → completed/failed transitions and the
/// "history cleared while running" edge case.
///
/// When the store has no entry for the session id (early launch, test
/// harness, missing bridge) the view falls through to the tool-call
/// result via ``ACPSpawnStatusIndicator/resolve(forToolCall:)`` so a
/// row that lands before the store is wired still renders sensibly.
private struct ACPSpawnStatusIndicatorView: View {
    let toolCall: ToolCallData
    let acpSessionId: String
    let store: ACPSessionStore?

    var body: some View {
        switch resolveIndicator() {
        case .pulsing:
            VBusyIndicator(size: 10)
        case .icon(let glyph, let role):
            VIconView(glyph.icon, size: 14)
                .foregroundStyle(role.color)
        }
    }

    /// Prefer the live store status — it picks up running → completed
    /// and the cleared-history fallback baked into the shared resolver.
    /// When the store has no entry at all (no `ACPSpawnAppDelegateBridge`
    /// in tests / preview harnesses), fall back to the tool call so the
    /// glyph still reflects whatever terminal state the spawn returned.
    private func resolveIndicator() -> ACPSpawnStatusIndicator {
        if let session = store?.sessions[acpSessionId] {
            return ACPSpawnStatusIndicator.resolve(forStatus: session.state.status)
        }
        return ACPSpawnStatusIndicator.resolve(forToolCall: toolCall)
    }
}

/// Indirection so the deep-link card can resolve the live
/// `ACPSessionStore` without `ToolCallProgressBar.swift` (a `shared/`
/// file) statically referencing the iOS `AppDelegate` class. The iOS
/// app delegate populates this slot on launch; tests assign directly.
@MainActor
public enum ACPSpawnAppDelegateBridge {
    /// Live `ACPSessionStore` for the running app. The slot is `weak`
    /// so the bridge doesn't keep the store alive past its natural
    /// lifetime — losing the reference during teardown surfaces as a
    /// soft no-op tap rather than a leak.
    public static weak var sharedStore: ACPSessionStore?
}
#endif
