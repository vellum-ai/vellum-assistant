import Foundation
import CoreGraphics
import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "HostCu")

// MARK: - Host CU Proxy Execution (macOS)

/// Registers the host CU request handler on a `GatewayConnectionManager`.
///
/// Call this once at setup time so that incoming `host_cu_request` messages
/// from the daemon are handled by the local verify -> execute -> observe cycle.
///
/// The `overlayProvider` callback supplies the `HostCuSessionProxy` for a given
/// session ID, creating one lazily on the first request. The executor updates
/// the proxy's state around each action so the overlay reflects progress.
///
/// Usage:
/// ```swift
/// HostCuExecutor.register(on: connectionManager) { conversationId, request in
///     return getOrCreateOverlayProxy(for: conversationId, request: request)
/// }
/// ```
enum HostCuExecutor {

    /// Host CU handling is now done in AppDelegate's subscribe loop.
    /// This method is retained as a no-op for source compatibility.
    @MainActor
    static func register(
        on client: GatewayConnectionManager,
        overlayProvider: @escaping @MainActor (_ conversationId: String, _ request: HostCuRequest) -> HostCuSessionProxy? = { _, _ in nil }
    ) {
        // No-op: host CU requests are handled via EventStreamClient.subscribe() in AppDelegate.
    }
}

// MARK: - Action Runner

/// Encapsulates the full host CU action cycle: map tool -> verify -> execute -> wait -> observe.
@MainActor
enum HostCuActionRunner {

    /// Default max steps shown in the overlay when the daemon doesn't provide one.
    private static let defaultMaxSteps = 50

    /// Per-session verifier state so safety checks (loop detection, step limits,
    /// "Enter after typing") accumulate across requests within the same session.
    private static var verifiers: [String: ActionVerifier] = [:]

    /// Per-session previous AX elements for computing diffs between steps.
    private static var previousAXElements: [String: [AXElement]] = [:]

    /// Remove session state when a session ends.
    static func clearSession(_ conversationId: String) {
        verifiers.removeValue(forKey: conversationId)
        previousAXElements.removeValue(forKey: conversationId)
    }

    static func perform(_ request: HostCuRequest, overlayProxy: HostCuSessionProxy? = nil) async -> HostCuResultPayload {
        let enumerator = AccessibilityTreeEnumerator()
        let screenCapture = ScreenCapture()
        let executor = ActionExecutor()
        let verifier = verifiers[request.conversationId] ?? {
            let v = ActionVerifier()
            verifiers[request.conversationId] = v
            return v
        }()

        // Map tool name + input to an AgentAction
        let agentAction = mapToAgentAction(toolName: request.toolName, input: request.input, reasoning: request.reasoning)

        // For observe-only requests, skip action execution and just capture state
        let isObserveOnly = request.toolName == "computer_use_observe" || request.toolName == "cu_observe"

        var executionResult: String? = nil
        var executionError: String? = nil

        if !isObserveOnly {
            // Resolve element IDs to coordinates if needed
            guard let resolvedAction = await resolveCoordinatesIfNeeded(for: agentAction, enumerator: enumerator, stepNumber: request.stepNumber) else {
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "Could not resolve element coordinates for action",
                    stepNumber: request.stepNumber,
                    conversationId: request.conversationId
                )
                return buildResultPayload(requestId: request.requestId, conversationId: request.conversationId, observation: obs, proxy: overlayProxy)
            }

            // Handle done/respond completion signals — transition overlay and skip execution
            if resolvedAction.type == .done {
                let summary = resolvedAction.summary ?? "Task completed"
                overlayProxy?.state = .completed(summary: summary, steps: request.stepNumber)
                clearSession(request.conversationId)
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: request.stepNumber,
                    conversationId: request.conversationId
                )
                return buildResultPayload(requestId: request.requestId, conversationId: request.conversationId, observation: obs, proxy: overlayProxy)
            }

            if resolvedAction.type == .respond {
                let answer = resolvedAction.text ?? resolvedAction.summary ?? ""
                overlayProxy?.state = .responded(answer: answer, steps: request.stepNumber)
                clearSession(request.conversationId)
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: request.stepNumber,
                    conversationId: request.conversationId
                )
                return buildResultPayload(requestId: request.requestId, conversationId: request.conversationId, observation: obs, proxy: overlayProxy)
            }

            // Update overlay state to running before execution
            overlayProxy?.state = .running(
                step: request.stepNumber,
                maxSteps: defaultMaxSteps,
                lastAction: resolvedAction.displayDescription,
                reasoning: request.reasoning ?? ""
            )

            // VERIFY (local safety check)
            let verifyResult = verifier.verify(resolvedAction)
            switch verifyResult {
            case .allowed:
                break

            case .needsConfirmation(let reason):
                log.warning("[\(request.stepNumber)] Needs confirmation (blocked in proxy): \(reason)")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "BLOCKED: \(reason) (confirmation not available in proxy mode)",
                    stepNumber: request.stepNumber,
                    conversationId: request.conversationId
                )
                return buildResultPayload(requestId: request.requestId, conversationId: request.conversationId, observation: obs, proxy: overlayProxy)

            case .blocked(let reason):
                log.warning("[\(request.stepNumber)] BLOCKED: \(reason)")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "BLOCKED: \(reason)",
                    stepNumber: request.stepNumber,
                    conversationId: request.conversationId
                )
                return buildResultPayload(requestId: request.requestId, conversationId: request.conversationId, observation: obs, proxy: overlayProxy)
            }

            // EXECUTE
            do {
                executionResult = try await executor.execute(resolvedAction)
            } catch {
                let errorMessage = error.localizedDescription
                if resolvedAction.type == .runAppleScript {
                    log.warning("[\(request.stepNumber)] AppleScript error (non-fatal): \(errorMessage)")
                }
                executionError = errorMessage
            }

            // WAIT — brief delay to let the UI settle after action
            do {
                try await Task.sleep(nanoseconds: 300_000_000) // 300ms
            } catch {
                log.warning("Post-action delay interrupted: \(error)")
            }
        }

        // Update overlay state to thinking after execution
        overlayProxy?.state = .thinking(step: request.stepNumber + 1, maxSteps: defaultMaxSteps)

        // OBSERVE — capture AX tree, screenshot, etc.
        let obs = await buildObservation(
            enumerator: enumerator,
            screenCapture: screenCapture,
            executionResult: executionResult,
            executionError: executionError,
            stepNumber: request.stepNumber,
            conversationId: request.conversationId
        )

        return buildResultPayload(requestId: request.requestId, conversationId: request.conversationId, observation: obs, proxy: overlayProxy)
    }

    // MARK: - Tool Name Mapping

    /// Map a tool name + input dictionary to an AgentAction.
    /// Maps a tool name + input dictionary to an `AgentAction` for local execution.
    private static func mapToAgentAction(toolName: String, input: [String: AnyCodable], reasoning: String?) -> AgentAction {
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
        let text = input["text"]?.value as? String
        let key = input["key"]?.value as? String
        let scrollDirection = input["direction"]?.value as? String
            ?? input["scrollDirection"]?.value as? String
            ?? input["scroll_direction"]?.value as? String
        let scrollAmount = extractInt(from: input, key: "amount")
            ?? extractInt(from: input, key: "scrollAmount")
            ?? extractInt(from: input, key: "scroll_amount")
        let summary = input["summary"]?.value as? String
        let waitDuration = extractInt(from: input, key: "duration_ms")
            ?? extractInt(from: input, key: "duration")
            ?? extractInt(from: input, key: "waitDuration")
            ?? extractInt(from: input, key: "wait_duration")
        let appName = input["app_name"]?.value as? String
            ?? input["appName"]?.value as? String
        let script = input["script"]?.value as? String
        let elementId = extractInt(from: input, key: "element_id")
            ?? extractInt(from: input, key: "elementId")
        let toElementId = extractInt(from: input, key: "to_element_id")
            ?? extractInt(from: input, key: "toElementId")
        let elementDescription = input["element_description"]?.value as? String
            ?? input["elementDescription"]?.value as? String

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
            summary: summary,
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

    /// Package observation data into a `HostCuResultPayload`.
    /// Drains any pending user guidance from the proxy and updates previous AX state.
    private static func buildResultPayload(requestId: String, conversationId: String, observation: ObservationData, proxy: HostCuSessionProxy? = nil) -> HostCuResultPayload {
        let guidance = proxy?.pendingUserGuidance
        proxy?.pendingUserGuidance = nil

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
            secondaryWindows: observation.secondaryWindows,
            userGuidance: guidance
        )
    }

    // MARK: - Input Helpers

    private static func extractCGFloat(from input: [String: AnyCodable], key: String) -> CGFloat? {
        guard let val = input[key]?.value else { return nil }
        if let intVal = val as? Int { return CGFloat(intVal) }
        if let doubleVal = val as? Double { return CGFloat(doubleVal) }
        return nil
    }

    private static func extractInt(from input: [String: AnyCodable], key: String) -> Int? {
        guard let val = input[key]?.value else { return nil }
        if let intVal = val as? Int { return intVal }
        if let doubleVal = val as? Double { return Int(doubleVal) }
        return nil
    }
}
