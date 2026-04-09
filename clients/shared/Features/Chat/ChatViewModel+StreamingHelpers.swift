import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatViewModel+StreamingHelpers")

// MARK: - Streaming Delta Throttle & Partial Output Coalescing

extension ChatViewModel {

    // MARK: - Thinking Delta Throttle

    /// Cancel any pending thinking flush and discard buffered thinking text.
    func discardThinkingBuffer() {
        thinkingFlushTask?.cancel()
        thinkingFlushTask = nil
        thinkingDeltaBuffer = ""
    }

    /// Flush any buffered thinking text into the messages array.
    /// Called eagerly before text flushes to maintain correct interleaving order.
    func flushThinkingBuffer() {
        thinkingFlushTask?.cancel()
        thinkingFlushTask = nil
        guard !thinkingDeltaBuffer.isEmpty else { return }
        let buffered = thinkingDeltaBuffer
        thinkingDeltaBuffer = ""
        appendThinkingToCurrentMessage(buffered)
    }

    /// Append a chunk of thinking text to the current assistant message.
    func appendThinkingToCurrentMessage(_ text: String) {
        guard !text.isEmpty else { return }
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            if let lastRef = messages[index].contentOrder.last,
               case .thinking(let segIdx) = lastRef {
                // Append to the existing thinking segment
                messages[index].thinkingSegments[segIdx] += text
            } else {
                // Create a new thinking segment
                let segIdx = messages[index].thinkingSegments.count
                messages[index].thinkingSegments.append(text)
                messages[index].contentOrder.append(.thinking(segIdx))
            }
        } else if currentAssistantMessageId != nil {
            log.warning("Stale currentAssistantMessageId \(self.currentAssistantMessageId!.uuidString) — discarding \(text.count) buffered thinking chars")
            currentAssistantMessageId = nil
            return
        } else {
            var msg = ChatMessage(role: .assistant, text: "", isStreaming: true)
            msg.thinkingSegments = [text]
            msg.contentOrder = [.thinking(0)]
            currentAssistantMessageId = msg.id
            messages.append(msg)
        }
    }

    /// Schedule a thinking flush after the throttle interval if one isn't already pending.
    func scheduleThinkingFlush() {
        guard thinkingFlushTask == nil else { return }
        thinkingFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.streamingFlushInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushThinkingBuffer()
        }
    }

    // MARK: - Streaming Delta Throttle

    /// Cancel any pending flush and discard buffered text.
    /// Called on every path that clears `currentAssistantMessageId` without
    /// a normal `messageComplete` (cancel, error, handoff, reconnect, etc.)
    /// to prevent a stale flush from creating an orphan assistant message.
    func discardStreamingBuffer() {
        discardThinkingBuffer()
        streamingFlushTask?.cancel()
        streamingFlushTask = nil
        streamingDeltaBuffer = ""
    }

    /// Flush any buffered streaming text into the messages array.
    /// Called on a timer and also eagerly on `messageComplete`,
    /// `toolUseStart`, `uiSurfaceShow`, etc.
    func flushStreamingBuffer() {
        flushThinkingBuffer()  // thinking before text in content order
        streamingFlushTask?.cancel()
        streamingFlushTask = nil
        guard !streamingDeltaBuffer.isEmpty else { return }
        let buffered = streamingDeltaBuffer
        streamingDeltaBuffer = ""
        appendTextToCurrentMessage(buffered)
    }

    /// Append a chunk of text to the current assistant message.
    func appendTextToCurrentMessage(_ text: String) {
        guard !text.isEmpty else { return }
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }) {
            let lastWasNonText: Bool = {
                guard let last = messages[index].contentOrder.last else { return false }
                if case .text = last { return false }
                return true  // .toolCall or .thinking
            }()
            if lastWasNonText || messages[index].textSegments.isEmpty {
                let segIdx = messages[index].textSegments.count
                messages[index].textSegments.append(text)
                messages[index].contentOrder.append(.text(segIdx))
            } else {
                messages[index].textSegments[messages[index].textSegments.count - 1] += text
            }
        } else if currentAssistantMessageId != nil {
            log.warning("Stale currentAssistantMessageId \(self.currentAssistantMessageId!.uuidString) — discarding \(text.count) buffered chars")
            currentAssistantMessageId = nil
            return
        } else {
            var msg = ChatMessage(role: .assistant, text: text, isStreaming: true)
            if currentTurnUserText == "/models" {
                msg.modelList = ModelListData()
            } else if currentTurnUserText == "/commands" {
                msg.commandList = CommandListData()
            }
            currentAssistantMessageId = msg.id
            messages.append(msg)
        }
    }

    /// Schedule a flush after the throttle interval if one isn't already pending.
    func scheduleStreamingFlush() {
        guard streamingFlushTask == nil else { return }
        streamingFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.streamingFlushInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushStreamingBuffer()
        }
    }

    // MARK: - Partial Output Coalescing

    /// Flush buffered partial-output chunks into the `messages` array.
    /// Called on a timer and eagerly on `messageComplete` / `toolResult`.
    func flushPartialOutputBuffer() {
        partialOutputFlushTask?.cancel()
        partialOutputFlushTask = nil
        guard !partialOutputBuffer.isEmpty else { return }
        let buffered = partialOutputBuffer
        partialOutputBuffer = [:]
        let maxPartialOutput = 5000
        for (_, entry) in buffered {
            let tcIndex = entry.tcIndex
            guard let msgIndex = messages.firstIndex(where: { $0.id == entry.messageId }),
                  tcIndex < messages[msgIndex].toolCalls.count else { continue }
            messages[msgIndex].toolCalls[tcIndex].partialOutput.append(entry.content)
            if messages[msgIndex].toolCalls[tcIndex].partialOutput.count > maxPartialOutput {
                let excess = messages[msgIndex].toolCalls[tcIndex].partialOutput.count - maxPartialOutput
                messages[msgIndex].toolCalls[tcIndex].partialOutput.removeFirst(excess)
            }
            messages[msgIndex].toolCalls[tcIndex].partialOutputRevision += 1
        }
    }

    /// Discard any buffered partial-output chunks without flushing.
    func discardPartialOutputBuffer() {
        partialOutputFlushTask?.cancel()
        partialOutputFlushTask = nil
        partialOutputBuffer = [:]
    }

    /// Schedule a partial-output flush after the throttle interval if one isn't already pending.
    func schedulePartialOutputFlush() {
        guard partialOutputFlushTask == nil else { return }
        partialOutputFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.streamingFlushInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushPartialOutputBuffer()
        }
    }

    // MARK: - Tool Use Streaming Handlers

    /// Handle a `tool_use_preview_start` event: create a preview chip for an upcoming tool call.
    func handleToolUsePreviewStart(_ msg: ToolUsePreviewStartMessage) {
        guard belongsToConversation(msg.conversationId) else { return }
        guard !isCancelling else { return }
        guard !isLoadingHistory else { return }
        guard !isWorkspaceRefinementInFlight else { return }
        // Suppress preview chip for proxy tools — the inline surface widget replaces them.
        if msg.toolName == "ui_show" || msg.toolName == "ui_update" || msg.toolName == "ui_dismiss" {
            return
        }
        // Flush buffered text so it lands before the tool call in content order.
        flushStreamingBuffer()
        flushPartialOutputBuffer()
        // If a chip with the same toolUseId already exists (e.g. toolUseStart
        // arrived before this preview), ignore the late preview.
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }),
           messages[index].toolCalls.contains(where: { $0.toolUseId == msg.toolUseId }) {
            return
        }
        isThinking = false
        var toolCall = ToolCallData(
            toolName: msg.toolName,
            inputSummary: "Preparing...",
            inputFull: "",
            inputRawValue: "",
            arrivedBeforeText: !currentAssistantHasText,
            startedAt: Date()
        )
        toolCall.toolUseId = msg.toolUseId
        // Add to existing assistant message or create one.
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }),
           messages[index].toolCalls.count < 100 {
            let tcIdx = messages[index].toolCalls.count
            messages[index].toolCalls.append(toolCall)
            messages[index].contentOrder.append(.toolCall(tcIdx))
        } else {
            if let existingId = currentAssistantMessageId,
               let oldIndex = messages.firstIndex(where: { $0.id == existingId }) {
                messages[oldIndex].isStreaming = false
            }
            var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [toolCall])
            newMsg.contentOrder = [.toolCall(0)]
            currentAssistantMessageId = newMsg.id
            messages.append(newMsg)
        }
    }

    /// Handle a `tool_use_start` event: create or update a tool call chip with input data.
    func handleToolUseStart(_ msg: ToolUseStartMessage) {
        guard belongsToConversation(msg.conversationId) else { return }
        guard !isCancelling else { return }
        guard !isLoadingHistory else { return }
        guard !isWorkspaceRefinementInFlight else { return }
        // Flush buffered text so it lands before the tool call in content order.
        flushStreamingBuffer()
        flushPartialOutputBuffer()
        lastToolUseReceivedAt = Date()
        // Suppress ToolCallChip for ui_show — the inline surface widget replaces it.
        if msg.toolName == "ui_show" || msg.toolName == "ui_update" || msg.toolName == "ui_dismiss" {
            return
        }
        // Tool chip is now visible — hide the thinking indicator
        isThinking = false
        // Extract building status for app tools
        let buildingStatus: String? = {
            let appTools: Set<String> = ["app_create", "app_refresh", "app_update"]
            guard appTools.contains(msg.toolName) else { return nil }
            if let status = msg.input["status"]?.value as? String, !status.isEmpty {
                return status
            }
            // app_create/app_refresh/app_update rely on friendlyRunningLabel + progressive label cycling
            return nil
        }()
        // Upsert by toolUseId: if a preview chip already exists for this tool, update it
        // instead of creating a duplicate.
        if let toolUseId = msg.toolUseId,
           let existingId = currentAssistantMessageId,
           let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
           let tcIndex = messages[msgIndex].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
            messages[msgIndex].toolCalls[tcIndex].inputSummary = summarizeToolInput(msg.input)
            messages[msgIndex].toolCalls[tcIndex].inputFull = formatAllToolInput(msg.input)
            messages[msgIndex].toolCalls[tcIndex].inputRawValue = extractToolInput(msg.input)
            messages[msgIndex].toolCalls[tcIndex].inputRawDict = msg.input
            messages[msgIndex].toolCalls[tcIndex].buildingStatus = buildingStatus
            messages[msgIndex].toolCalls[tcIndex].reasonDescription = ((msg.input["activity"]?.value as? String)
                ?? (msg.input["reason"]?.value as? String)
                ?? (msg.input["reasoning"]?.value as? String)).map { ToolCallData.displaySafe($0) }
            return
        }
        var toolCall = ToolCallData(
            toolName: msg.toolName,
            inputSummary: summarizeToolInput(msg.input),
            inputFull: formatAllToolInput(msg.input),
            inputRawValue: extractToolInput(msg.input),
            arrivedBeforeText: !currentAssistantHasText,
            startedAt: Date()
        )
        toolCall.buildingStatus = buildingStatus
        toolCall.toolUseId = msg.toolUseId
        toolCall.inputRawDict = msg.input
        toolCall.reasonDescription = ((msg.input["activity"]?.value as? String)
            ?? (msg.input["reason"]?.value as? String)
            ?? (msg.input["reasoning"]?.value as? String)).map { ToolCallData.displaySafe($0) }
        // Add to existing assistant message or create one.
        // Cap at 100 tool calls per message to prevent unbounded memory growth;
        // overflow falls through to create a new message.
        if let existingId = currentAssistantMessageId,
           let index = messages.firstIndex(where: { $0.id == existingId }),
           messages[index].toolCalls.count < 100 {
            let tcIdx = messages[index].toolCalls.count
            messages[index].toolCalls.append(toolCall)
            messages[index].contentOrder.append(.toolCall(tcIdx))
        } else {
            // Cap reached — rotate to a new message.
            // Clear streaming state on the old message first.
            if let existingId = currentAssistantMessageId,
               let oldIndex = messages.firstIndex(where: { $0.id == existingId }) {
                messages[oldIndex].isStreaming = false
            }
            var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true, toolCalls: [toolCall])
            newMsg.contentOrder = [.toolCall(0)]
            currentAssistantMessageId = newMsg.id
            messages.append(newMsg)
        }
    }

    /// Handle a `tool_input_delta` event: update streaming code preview for a tool call.
    func handleToolInputDelta(_ msg: ToolInputDeltaMessage) {
        guard belongsToConversation(msg.conversationId) else { return }
        guard !isCancelling else { return }
        guard !isLoadingHistory else { return }
        let preview = Self.extractCodePreview(from: msg.content, toolName: msg.toolName)
        // If toolUseId is present, find the matching tool call and update its streaming preview.
        if let toolUseId = msg.toolUseId,
           let existingId = currentAssistantMessageId,
           let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
           let tcIndex = messages[msgIndex].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
            // Update code preview on the message for the matched tool call
            messages[msgIndex].streamingCodePreview = preview
            messages[msgIndex].streamingCodeToolName = msg.toolName
            _ = tcIndex // suppress unused warning — match confirms the tool call exists
        } else if let existingId = currentAssistantMessageId,
           let msgIndex = messages.firstIndex(where: { $0.id == existingId }) {
            messages[msgIndex].streamingCodePreview = preview
            messages[msgIndex].streamingCodeToolName = msg.toolName
        } else {
            var newMsg = ChatMessage(role: .assistant, text: "", isStreaming: true)
            newMsg.streamingCodePreview = preview
            newMsg.streamingCodeToolName = msg.toolName
            currentAssistantMessageId = newMsg.id
            messages.append(newMsg)
        }
    }

    /// Handle a `tool_output_chunk` event: buffer partial output for coalesced flushing.
    func handleToolOutputChunk(_ msg: ToolOutputChunkMessage) {
        guard !isCancelling else { return }
        guard belongsToConversation(msg.conversationId) else { return }
        guard !isLoadingHistory else { return }
        if (msg.subType == nil || msg.subType?.isEmpty == true),
           !msg.chunk.isEmpty {
            // Resolve target tool call: prefer toolUseId, fall back to positional heuristic.
            let resolvedPlainTarget: (msgIndex: Int, tcIndex: Int)? = {
                if let toolUseId = msg.toolUseId {
                    for i in stride(from: messages.count - 1, through: 0, by: -1) {
                        if let tcIdx = messages[i].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                            return (i, tcIdx)
                        }
                    }
                }
                if let existingId = currentAssistantMessageId,
                   let mIdx = messages.firstIndex(where: { $0.id == existingId }),
                   let tcIdx = messages[mIdx].toolCalls.lastIndex(where: { !$0.isComplete }) {
                    return (mIdx, tcIdx)
                }
                return nil
            }()
            guard let target = resolvedPlainTarget else { return }
            let msgIndex = target.msgIndex
            let tcIndex = target.tcIndex
            // Append plain-text output chunks to the coalescing buffer.
            // Structured JSON sub-events (with a valid subType) are handled above;
            // the subType guard prevents them from leaking raw JSON here.
            let messageId = messages[msgIndex].id
            let key = "\(messageId):\(tcIndex)"
            if var entry = partialOutputBuffer[key] {
                entry.content += msg.chunk
                partialOutputBuffer[key] = entry
            } else {
                partialOutputBuffer[key] = (messageId: messageId, tcIndex: tcIndex, content: msg.chunk)
            }
            schedulePartialOutputFlush()
        }
    }

    /// Handle a `tool_result` event: mark a tool call as complete with its result.
    func handleToolResult(_ msg: ToolResultMessage) {
        guard belongsToConversation(msg.conversationId) else { return }
        guard !isCancelling else { return }
        guard !isLoadingHistory else { return }
        guard !isWorkspaceRefinementInFlight else { return }
        flushPartialOutputBuffer()
        // Find the matching tool call.
        // Prefer matching by toolUseId (stable identifier) over positional heuristics.
        var targetMsgIndex: Int?
        var targetTcIndex: Int?
        if let toolUseId = msg.toolUseId {
            // Search all messages for a tool call with matching toolUseId
            for i in stride(from: messages.count - 1, through: 0, by: -1) {
                if let tcIndex = messages[i].toolCalls.firstIndex(where: { $0.toolUseId == toolUseId }) {
                    targetMsgIndex = i
                    targetTcIndex = tcIndex
                    break
                }
            }
        }
        // Fall back to existing positional heuristic if no ID match.
        if targetMsgIndex == nil {
            if let existingId = currentAssistantMessageId,
               let msgIndex = messages.firstIndex(where: { $0.id == existingId }),
               let tcIndex = messages[msgIndex].toolCalls.lastIndex(where: { !$0.isComplete }) {
                targetMsgIndex = msgIndex
                targetTcIndex = tcIndex
            } else if let existingId = currentAssistantMessageId,
                      let currentIdx = messages.firstIndex(where: { $0.id == existingId }) {
                // Current assistant message has no incomplete tool calls.
                // Search backward from current message position for rotated messages.
                for i in stride(from: currentIdx - 1, through: max(0, currentIdx - 5), by: -1) {
                    guard messages[i].role == .assistant else { continue }
                    if let tcIndex = messages[i].toolCalls.lastIndex(where: { !$0.isComplete }) {
                        targetMsgIndex = i
                        targetTcIndex = tcIndex
                        break
                    }
                }
            } else {
                // currentAssistantMessageId is nil — search backward within current turn
                // (reconnect scenario where there are no queued messages).
                let lastUserIndex = messages.lastIndex(where: { $0.role == .user }) ?? 0
                for i in stride(from: messages.count - 1, through: lastUserIndex, by: -1) {
                    guard messages[i].role == .assistant else { continue }
                    if let tcIndex = messages[i].toolCalls.lastIndex(where: { !$0.isComplete }) {
                        targetMsgIndex = i
                        targetTcIndex = tcIndex
                        break
                    }
                }
            }
        }
        if let msgIndex = targetMsgIndex, let tcIndex = targetTcIndex {
            messages[msgIndex].toolCalls[tcIndex].result = msg.result
            messages[msgIndex].toolCalls[tcIndex].resultLength = msg.result.count
            messages[msgIndex].toolCalls[tcIndex].isError = msg.isError ?? false
            messages[msgIndex].toolCalls[tcIndex].isComplete = true
            messages[msgIndex].toolCalls[tcIndex].completedAt = Date()
            let decoded = (msg.imageDataList ?? []).compactMap { ToolCallData.decodeImage(from: $0) }
            // Keep cachedImages for display, nil out raw base64 to save memory
            messages[msgIndex].toolCalls[tcIndex].cachedImages = decoded
            messages[msgIndex].toolCalls[tcIndex].imageDataList = decoded.isEmpty ? msg.imageDataList : nil
            if let status = msg.status, !status.isEmpty {
                messages[msgIndex].toolCalls[tcIndex].buildingStatus = status
            }
            let toolErrored = msg.isError ?? false
            downgradeAdjacentApprovedConfirmationForPermissionDeniedError(
                assistantMessageIndex: msgIndex,
                toolResult: msg.result,
                isError: toolErrored
            )
            if toolErrored, Self.isOSPermissionDeniedError(msg.result),
               messages[msgIndex].toolCalls[tcIndex].confirmationDecision == .approved {
                messages[msgIndex].toolCalls[tcIndex].confirmationDecision = .denied
            }
            // When an app tool call completes, mark dynamic page surfaces as
            // ready so the inline card enables its "Open App" button. Search
            // the matched message first, then fall back to the current assistant
            // message in case the surface ended up in a different message due
            // to rotation or toolUseId-based matching across messages.
            let toolName = messages[msgIndex].toolCalls[tcIndex].toolName
            if toolName == "app_create" || toolName == "app_refresh" || toolName == "app_update" {
                var found = false
                for surfIdx in messages[msgIndex].inlineSurfaces.indices {
                    if case .dynamicPage = messages[msgIndex].inlineSurfaces[surfIdx].data {
                        messages[msgIndex].inlineSurfaces[surfIdx].isToolCallComplete = true
                        found = true
                    }
                }
                if !found, let currentId = currentAssistantMessageId,
                   let currentIdx = messages.firstIndex(where: { $0.id == currentId }),
                   currentIdx != msgIndex {
                    for surfIdx in messages[currentIdx].inlineSurfaces.indices {
                        if case .dynamicPage = messages[currentIdx].inlineSurfaces[surfIdx].data {
                            messages[currentIdx].inlineSurfaces[surfIdx].isToolCallComplete = true
                        }
                    }
                }
            }
        }
        // Auto-open clip files in the default video player.
        // Use msg.toolName from the event payload (stable) instead of the
        // matched tool call's toolName (relies on last-incomplete heuristic).
        autoOpenClipIfNeeded(
            toolName: msg.toolName,
            result: msg.result,
            isError: msg.isError ?? false
        )

        // Tool completed — don't re-show "Thinking..." here. The tool
        // call chip already indicates activity, and the LLM isn't actually
        // thinking yet. isThinking will be set when the user sends a new
        // message or the daemon echoes it back.
    }
}
