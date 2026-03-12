import Foundation
import CoreGraphics
import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostCu")

// MARK: - Host CU Proxy Execution (macOS)

/// Registers the host CU request handler on a `DaemonClient`.
///
/// Call this once at setup time so that incoming `host_cu_request` messages
/// from the daemon are handled by the local verify -> execute -> observe cycle.
///
/// Usage:
/// ```swift
/// HostCuExecutor.register(on: daemonClient)
/// ```
enum HostCuExecutor {

    /// Register the host CU handler on the given daemon client.
    /// The handler will execute CU actions locally and post results back.
    @MainActor
    static func register(on client: DaemonClient) {
        client.onHostCuRequest = { [weak client] request in
            guard let client else { return }
            Task { @MainActor in
                let result = await HostCuActionRunner.perform(request)
                log.debug("Host CU completed — requestId=\(request.requestId, privacy: .public) toolName=\(request.toolName, privacy: .public)")
                await client.httpTransport?.postHostCuResult(result)
            }
        }
    }
}

// MARK: - Action Runner

/// Encapsulates the full host CU action cycle: map tool -> verify -> execute -> wait -> observe.
@MainActor
enum HostCuActionRunner {

    static func perform(_ request: HostCuRequest) async -> HostCuResultPayload {
        let enumerator = AccessibilityTreeEnumerator()
        let screenCapture = ScreenCapture()
        let executor = ActionExecutor()
        let verifier = ActionVerifier()

        // Map tool name + input to an AgentAction
        let agentAction = mapToAgentAction(toolName: request.toolName, input: request.input, reasoning: request.reasoning)

        // For observe-only requests, skip action execution and just capture state
        let isObserveOnly = request.toolName == "computer_use_observe" || request.toolName == "cu_observe"

        var executionResult: String? = nil
        var executionError: String? = nil

        if !isObserveOnly {
            // Resolve element IDs to coordinates if needed
            guard let resolvedAction = resolveCoordinatesIfNeeded(for: agentAction, enumerator: enumerator, stepNumber: request.stepNumber) else {
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "Could not resolve element coordinates for action",
                    stepNumber: request.stepNumber
                )
                return buildResultPayload(requestId: request.requestId, observation: obs)
            }

            // Skip execution for done/respond — those are completion signals
            if resolvedAction.type == .done || resolvedAction.type == .respond {
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: request.stepNumber
                )
                return buildResultPayload(requestId: request.requestId, observation: obs)
            }

            // VERIFY (local safety check)
            let verifyResult = verifier.verify(resolvedAction)
            switch verifyResult {
            case .allowed:
                verifier.resetBlockCount()

            case .needsConfirmation(let reason):
                // In the host CU proxy context, auto-approve low-risk actions
                // (AppleScript). Higher-risk actions are blocked since there's
                // no interactive confirmation UI in this path.
                let isLowRisk = resolvedAction.type == .runAppleScript
                if isLowRisk {
                    log.info("[\(request.stepNumber)] Auto-approved: \(reason)")
                    verifier.recordConfirmedAction(resolvedAction)
                    verifier.resetBlockCount()
                } else {
                    log.warning("[\(request.stepNumber)] Needs confirmation (blocked in proxy): \(reason)")
                    let obs = await buildObservation(
                        enumerator: enumerator,
                        screenCapture: screenCapture,
                        executionResult: nil,
                        executionError: "BLOCKED: \(reason) (confirmation not available in proxy mode)",
                        stepNumber: request.stepNumber
                    )
                    return buildResultPayload(requestId: request.requestId, observation: obs)
                }

            case .blocked(let reason):
                log.warning("[\(request.stepNumber)] BLOCKED: \(reason)")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "BLOCKED: \(reason)",
                    stepNumber: request.stepNumber
                )
                return buildResultPayload(requestId: request.requestId, observation: obs)
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

        // OBSERVE — capture AX tree, screenshot, etc.
        let obs = await buildObservation(
            enumerator: enumerator,
            screenCapture: screenCapture,
            executionResult: executionResult,
            executionError: executionError,
            stepNumber: request.stepNumber
        )

        return buildResultPayload(requestId: request.requestId, observation: obs)
    }

    // MARK: - Tool Name Mapping

    /// Map a tool name + input dictionary to an AgentAction.
    /// Replicates the logic from `ComputerUseSession.mapToAgentAction`.
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
        let waitDuration = extractInt(from: input, key: "duration")
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
    private static func resolveCoordinatesIfNeeded(for action: AgentAction, enumerator: AccessibilityTreeProviding, stepNumber: Int) -> AgentAction? {
        var resolved = action

        switch resolved.type {
        case .click, .doubleClick, .rightClick:
            if resolved.x == nil || resolved.y == nil {
                guard let sourceId = resolved.resolvedFromElementId else {
                    log.error("[\(stepNumber)] Action requires either x/y coordinates or element_id")
                    return nil
                }
                guard let center = elementCenter(for: sourceId, enumerator: enumerator) else {
                    log.error("[\(stepNumber)] Could not resolve element_id [\(sourceId)]")
                    return nil
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .scroll:
            if (resolved.x == nil || resolved.y == nil), let sourceId = resolved.resolvedFromElementId {
                guard let center = elementCenter(for: sourceId, enumerator: enumerator) else {
                    log.error("[\(stepNumber)] Could not resolve element_id [\(sourceId)]")
                    return nil
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .drag:
            if resolved.x == nil || resolved.y == nil, let sourceId = resolved.resolvedFromElementId {
                if let center = elementCenter(for: sourceId, enumerator: enumerator) {
                    resolved.x = center.x
                    resolved.y = center.y
                }
            }
            if resolved.toX == nil || resolved.toY == nil, let targetId = resolved.resolvedToElementId {
                if let center = elementCenter(for: targetId, enumerator: enumerator) {
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
    private static func elementCenter(for elementId: Int, enumerator: AccessibilityTreeProviding) -> CGPoint? {
        guard let result = enumerator.enumerateCurrentWindow() else { return nil }
        let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
        guard let element = flat.first(where: { $0.id == elementId }) else { return nil }
        let frame = element.frame
        return CGPoint(x: frame.midX, y: frame.midY)
    }

    // MARK: - Observation Builder

    /// Internal observation data before packaging into the result payload.
    private struct ObservationData {
        let axTree: String?
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
        stepNumber: Int
    ) async -> ObservationData {
        var axTreeText: String?
        var screenshotBase64: String?
        var screenshotWidthPx: Int?
        var screenshotHeightPx: Int?
        var screenWidthPt: Int?
        var screenHeightPt: Int?
        var secondaryWindowsText: String?

        if let result = enumerator.enumerateCurrentWindow() {
            axTreeText = AccessibilityTreeEnumerator.formatAXTree(
                elements: result.elements,
                windowTitle: result.windowTitle,
                appName: result.appName
            )
            let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
            let interactiveCount = flat.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
            log.info("[\(stepNumber)] AX tree: \(result.appName) — \"\(result.windowTitle)\" — \(flat.count) elements (\(interactiveCount) interactive)")

            // Enumerate secondary windows on first step
            if stepNumber <= 1 {
                let secondaryWindows = enumerator.enumerateSecondaryWindows(
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
    private static func buildResultPayload(requestId: String, observation: ObservationData) -> HostCuResultPayload {
        HostCuResultPayload(
            requestId: requestId,
            axTree: observation.axTree,
            axDiff: nil, // Diff requires tracking previous state across requests; handled server-side
            screenshot: observation.screenshot,
            screenshotWidthPx: observation.screenshotWidthPx,
            screenshotHeightPx: observation.screenshotHeightPx,
            screenWidthPt: observation.screenWidthPt,
            screenHeightPt: observation.screenHeightPt,
            executionResult: observation.executionResult,
            executionError: observation.executionError,
            secondaryWindows: observation.secondaryWindows,
            userGuidance: nil
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
