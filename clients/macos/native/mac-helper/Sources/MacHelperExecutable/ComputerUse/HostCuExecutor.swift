import Foundation
import CoreGraphics
import AppKit
import os

private let log = Logger(subsystem: "ai.vellum.mac-helper", category: "HostCu")

// MARK: - Action Runner

/// Encapsulates the full host CU action cycle: map tool -> verify -> execute -> wait -> observe.
@MainActor
enum HostCuActionRunner {

    /// Per-session verifier state so safety checks (loop detection, step limits,
    /// "Enter after typing") accumulate across requests within the same session.
    private static var verifiers: [String: ActionVerifier] = [:]

    /// Per-session previous AX elements for computing diffs between steps.
    private static var previousAXElements: [String: [AXElement]] = [:]

    /// Last time each session was touched, for reclaiming state from sessions
    /// that end without a terminal done/respond (cancelled, or conversation
    /// closed mid-flight).
    private static var lastAccess: [String: Date] = [:]

    /// Idle window after which an untouched session's state is reclaimed.
    private static let sessionTTL: TimeInterval = 600

    /// Remove session state when a session ends.
    static func clearSession(_ conversationId: String) {
        verifiers.removeValue(forKey: conversationId)
        previousAXElements.removeValue(forKey: conversationId)
        lastAccess.removeValue(forKey: conversationId)
    }

    /// Evict state for sessions untouched longer than `sessionTTL`, then record
    /// `conversationId` as just-accessed. Bounds memory for abandoned sessions.
    private static func touchSession(_ conversationId: String, now: Date = Date()) {
        for (id, seen) in lastAccess where now.timeIntervalSince(seen) > sessionTTL {
            verifiers.removeValue(forKey: id)
            previousAXElements.removeValue(forKey: id)
            lastAccess.removeValue(forKey: id)
        }
        lastAccess[conversationId] = now
    }

    static func perform(
        requestId: String,
        conversationId: String,
        toolName: String,
        input: [String: Any],
        stepNumber: Int,
        reasoning: String?
    ) async -> HostCuResultPayload {
        touchSession(conversationId)
        let enumerator = AccessibilityTreeEnumerator()
        let screenCapture = ScreenCapture()
        let executor = ActionExecutor()
        let verifier = verifiers[conversationId] ?? {
            let v = ActionVerifier()
            verifiers[conversationId] = v
            return v
        }()

        // Map tool name + input to an AgentAction
        let agentAction = mapToAgentAction(toolName: toolName, input: input, reasoning: reasoning)

        // For observe-only requests, skip action execution and just capture state
        let isObserveOnly = toolName == "computer_use_observe" || toolName == "cu_observe"

        var executionResult: String? = nil
        var executionError: String? = nil

        if !isObserveOnly {
            // Ensure Accessibility is granted before any CGEvent input, which
            // silently fails otherwise. Prompt the user on first miss.
            if !ActionExecutor.checkAccessibilityPermission(prompt: true) {
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "Accessibility permission not granted. Grant Vellum access in System Settings > Privacy & Security > Accessibility, then retry.",
                    stepNumber: stepNumber,
                    conversationId: conversationId
                )
                return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)
            }

            // Resolve element IDs to coordinates if needed
            guard let resolvedAction = await resolveCoordinatesIfNeeded(for: agentAction, enumerator: enumerator, stepNumber: stepNumber) else {
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "Could not resolve element coordinates for action",
                    stepNumber: stepNumber,
                    conversationId: conversationId
                )
                return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)
            }

            // Handle done/respond completion signals — skip execution
            if resolvedAction.type == .done {
                clearSession(conversationId)
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: stepNumber,
                    conversationId: conversationId
                )
                return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)
            }

            if resolvedAction.type == .respond {
                clearSession(conversationId)
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: stepNumber,
                    conversationId: conversationId
                )
                return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)
            }

            // VERIFY (local safety check)
            let verifyResult = verifier.verify(resolvedAction)
            switch verifyResult {
            case .allowed:
                break

            case .needsConfirmation(let reason):
                log.warning("[\(stepNumber)] Needs confirmation (blocked in proxy): \(reason)")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "BLOCKED: \(reason) (confirmation not available in proxy mode)",
                    stepNumber: stepNumber,
                    conversationId: conversationId
                )
                return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)

            case .blocked(let reason):
                log.warning("[\(stepNumber)] BLOCKED: \(reason)")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "BLOCKED: \(reason)",
                    stepNumber: stepNumber,
                    conversationId: conversationId
                )
                return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)
            }

            // EXECUTE
            do {
                executionResult = try await executor.execute(resolvedAction)
            } catch {
                let errorMessage = error.localizedDescription
                if resolvedAction.type == .runAppleScript {
                    log.warning("[\(stepNumber)] AppleScript error (non-fatal): \(errorMessage)")
                }
                executionError = errorMessage
            }

            // WAIT — brief delay to let the UI settle after action
            do {
                try await Task.sleep(nanoseconds: 300_000_000) // 300ms
            } catch {
                log.warning("Post-action delay interrupted: \(error)")
            }
        } else {
            // Observe-only skips the action-path gate, but AX enumeration silently
            // returns an empty tree without Accessibility. Surface the same hint the
            // action path gives instead of returning a bare empty observation.
            if !ActionExecutor.checkAccessibilityPermission(prompt: true) {
                executionError = "Accessibility permission not granted. Grant Vellum access in System Settings > Privacy & Security > Accessibility, then retry."
            }
        }

        // OBSERVE — capture AX tree, screenshot, etc.
        let obs = await buildObservation(
            enumerator: enumerator,
            screenCapture: screenCapture,
            executionResult: executionResult,
            executionError: executionError,
            stepNumber: stepNumber,
            conversationId: conversationId
        )

        return buildResultPayload(requestId: requestId, conversationId: conversationId, observation: obs)
    }

    // MARK: - Tool Name Mapping

    /// Maps a tool name + input dictionary to an `AgentAction` for local execution.
    private static func mapToAgentAction(toolName: String, input: [String: Any], reasoning: String?) -> AgentAction {
        let type: ActionType = switch toolName {
        case "computer_use_click", "cu_click": .click
        case "computer_use_double_click", "cu_double_click": .doubleClick
        case "computer_use_right_click", "cu_right_click": .rightClick
        case "computer_use_type_text", "cu_type_text": .type
        case "computer_use_key", "cu_key": .key
        case "computer_use_scroll", "cu_scroll": .scroll
        case "computer_use_wait", "cu_wait": .wait
        case "computer_use_drag", "cu_drag": .drag
        case "computer_use_open_app", "cu_open_app": .openApp
        case "computer_use_run_applescript", "cu_run_applescript": .runAppleScript
        case "computer_use_done", "cu_done": .done
        case "computer_use_respond", "cu_respond": .respond
        default: .done
        }

        let x = extractCGFloat(from: input, key: "x")
        let y = extractCGFloat(from: input, key: "y")
        let toX = extractCGFloat(from: input, key: "toX")
            ?? extractCGFloat(from: input, key: "to_x")
        let toY = extractCGFloat(from: input, key: "toY")
            ?? extractCGFloat(from: input, key: "to_y")
        let text = input["text"] as? String
        let key = input["key"] as? String
        let scrollDirection = input["direction"] as? String
            ?? input["scrollDirection"] as? String
            ?? input["scroll_direction"] as? String
        let scrollAmount = extractInt(from: input, key: "amount")
            ?? extractInt(from: input, key: "scrollAmount")
            ?? extractInt(from: input, key: "scroll_amount")
        let waitDuration = extractInt(from: input, key: "duration_ms")
            ?? extractInt(from: input, key: "duration")
            ?? extractInt(from: input, key: "waitDuration")
            ?? extractInt(from: input, key: "wait_duration")
        let appName = input["app_name"] as? String
            ?? input["appName"] as? String
        let script = input["script"] as? String
        let elementId = extractInt(from: input, key: "element_id")
            ?? extractInt(from: input, key: "elementId")
        let toElementId = extractInt(from: input, key: "to_element_id")
            ?? extractInt(from: input, key: "toElementId")
        let elementDescription = input["element_description"] as? String
            ?? input["elementDescription"] as? String

        return AgentAction(
            type: type,
            reasoning: reasoning ?? "",
            x: x,
            y: y,
            toX: toX,
            toY: toY,
            text: text,
            key: key,
            scrollDirection: scrollDirection,
            scrollAmount: scrollAmount,
            waitDuration: waitDuration,
            appName: appName,
            script: script,
            resolvedFromElementId: elementId,
            resolvedToElementId: toElementId,
            elementDescription: elementDescription
        )
    }

    // MARK: - Coordinate Resolution

    /// Resolve element IDs to screen coordinates when x/y are not provided.
    private static func resolveCoordinatesIfNeeded(for action: AgentAction, enumerator: AccessibilityTreeProviding, stepNumber: Int) async -> AgentAction? {
        var resolved = action

        switch resolved.type {
        case .click, .doubleClick, .rightClick:
            if resolved.x == nil || resolved.y == nil {
                guard let sourceId = resolved.resolvedFromElementId else {
                    log.error("[\(stepNumber)] Action requires either x/y coordinates or element_id")
                    return nil
                }
                guard let center = await elementCenter(for: sourceId, enumerator: enumerator) else {
                    log.error("[\(stepNumber)] Could not resolve element_id [\(sourceId)]")
                    return nil
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .scroll:
            if (resolved.x == nil || resolved.y == nil), let sourceId = resolved.resolvedFromElementId {
                guard let center = await elementCenter(for: sourceId, enumerator: enumerator) else {
                    log.error("[\(stepNumber)] Could not resolve element_id [\(sourceId)]")
                    return nil
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .drag:
            if resolved.x == nil || resolved.y == nil, let sourceId = resolved.resolvedFromElementId {
                if let center = await elementCenter(for: sourceId, enumerator: enumerator) {
                    resolved.x = center.x
                    resolved.y = center.y
                }
            }
            if resolved.toX == nil || resolved.toY == nil, let targetId = resolved.resolvedToElementId {
                if let center = await elementCenter(for: targetId, enumerator: enumerator) {
                    resolved.toX = center.x
                    resolved.toY = center.y
                }
            }

        default:
            break
        }

        return resolved
    }

    /// Find the center point of an AX element by ID in the current window.
    private static func elementCenter(for elementId: Int, enumerator: AccessibilityTreeProviding) async -> CGPoint? {
        guard let result = await enumerator.enumerateCurrentWindow() else { return nil }
        let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
        guard let element = flat.first(where: { $0.id == elementId }) else { return nil }
        let frame = element.frame
        return CGPoint(x: frame.midX, y: frame.midY)
    }

    // MARK: - Observation Builder

    /// Internal observation data before packaging into the result payload.
    private struct ObservationData {
        let axTree: String?
        let axDiff: String?
        let currentElements: [AXElement]?
        let screenshot: String?
        let screenshotWidthPx: Int?
        let screenshotHeightPx: Int?
        let screenWidthPt: Int?
        let screenHeightPt: Int?
        let executionResult: String?
        let executionError: String?
        let secondaryWindows: String?
    }

    /// Capture the current screen state as an observation.
    private static func buildObservation(
        enumerator: AccessibilityTreeProviding,
        screenCapture: ScreenCaptureProviding,
        executionResult: String?,
        executionError: String?,
        stepNumber: Int,
        conversationId: String
    ) async -> ObservationData {
        var axTreeText: String?
        var axDiffText: String?
        var currentElements: [AXElement]?
        var screenshotBase64: String?
        var screenshotWidthPx: Int?
        var screenshotHeightPx: Int?
        var screenWidthPt: Int?
        var screenHeightPt: Int?
        var secondaryWindowsText: String?

        if let result = await enumerator.enumerateCurrentWindow() {
            axTreeText = AccessibilityTreeEnumerator.formatAXTree(
                elements: result.elements,
                windowTitle: result.windowTitle,
                appName: result.appName
            )
            let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
            currentElements = flat
            let interactiveCount = flat.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
            log.info("[\(stepNumber)] AX tree: \(result.appName) — \"\(result.windowTitle)\" — \(flat.count) elements (\(interactiveCount) interactive)")

            // Compute AX diff against previous step's elements
            if let previousFlat = previousAXElements[conversationId] {
                axDiffText = AXTreeDiff.diff(previousFlat: previousFlat, currentFlat: flat)
            }

            // Enumerate secondary windows on first step
            if stepNumber <= 1 {
                let secondaryWindows = await enumerator.enumerateSecondaryWindows(
                    excludingPID: result.pid,
                    maxWindows: 2
                )
                secondaryWindowsText = AccessibilityTreeEnumerator.formatSecondaryWindows(secondaryWindows)
            }

            // Capture screenshot
            do {
                let screenshotResult = try await screenCapture.captureScreenWithMetadata(maxWidth: 960, maxHeight: 540)
                screenshotBase64 = screenshotResult.jpegData.base64EncodedString()
                if let meta = screenshotResult.metadata {
                    screenshotWidthPx = meta.screenshotWidthPx
                    screenshotHeightPx = meta.screenshotHeightPx
                }
                let screenSize = screenCapture.screenSize()
                screenWidthPt = Int(screenSize.width)
                screenHeightPt = Int(screenSize.height)
            } catch {
                log.error("[\(stepNumber)] Screenshot capture failed: \(error)")
            }
        } else {
            // No focused window — try screenshot as fallback
            log.warning("[\(stepNumber)] No AX tree available — falling back to screenshot")
            do {
                let screenshotResult = try await screenCapture.captureScreenWithMetadata(maxWidth: 960, maxHeight: 540)
                screenshotBase64 = screenshotResult.jpegData.base64EncodedString()
                if let meta = screenshotResult.metadata {
                    screenshotWidthPx = meta.screenshotWidthPx
                    screenshotHeightPx = meta.screenshotHeightPx
                }
                let screenSize = screenCapture.screenSize()
                screenWidthPt = Int(screenSize.width)
                screenHeightPt = Int(screenSize.height)
            } catch {
                log.error("[\(stepNumber)] Screen capture failed: \(error)")
            }
        }

        return ObservationData(
            axTree: axTreeText,
            axDiff: axDiffText,
            currentElements: currentElements,
            screenshot: screenshotBase64,
            screenshotWidthPx: screenshotWidthPx,
            screenshotHeightPx: screenshotHeightPx,
            screenWidthPt: screenWidthPt,
            screenHeightPt: screenHeightPt,
            executionResult: executionResult,
            executionError: executionError,
            secondaryWindows: secondaryWindowsText
        )
    }

    /// Package observation data into a `HostCuResultPayload` and update previous AX state.
    private static func buildResultPayload(requestId: String, conversationId: String, observation: ObservationData) -> HostCuResultPayload {
        // Update previous AX elements for next step's diff
        if let elements = observation.currentElements {
            previousAXElements[conversationId] = elements
        }

        return HostCuResultPayload(
            requestId: requestId,
            axTree: observation.axTree,
            axDiff: observation.axDiff,
            screenshot: observation.screenshot,
            screenshotWidthPx: observation.screenshotWidthPx,
            screenshotHeightPx: observation.screenshotHeightPx,
            screenWidthPt: observation.screenWidthPt,
            screenHeightPt: observation.screenHeightPt,
            executionResult: observation.executionResult,
            executionError: observation.executionError,
            secondaryWindows: observation.secondaryWindows
        )
    }

    // MARK: - Input Helpers

    private static func extractCGFloat(from input: [String: Any], key: String) -> CGFloat? {
        guard let val = input[key] else { return nil }
        if let intVal = val as? Int { return CGFloat(intVal) }
        if let doubleVal = val as? Double { return CGFloat(doubleVal) }
        if let num = val as? NSNumber { return CGFloat(num.doubleValue) }
        return nil
    }

    private static func extractInt(from input: [String: Any], key: String) -> Int? {
        guard let val = input[key] else { return nil }
        if let intVal = val as? Int { return intVal }
        if let doubleVal = val as? Double { return Int(doubleVal) }
        if let num = val as? NSNumber { return num.intValue }
        return nil
    }
}
