import Foundation
import CoreGraphics
import AppKit
import MacHelperCore
import os

private let log = Logger(subsystem: "ai.vellum.mac-helper", category: "HostCu")

// MARK: - Phase Timing

/// The phases of one step, named as they reach the daemon in the `timings` map.
private enum CuPhase: String {
    case total
    case execute
    case settle
    case axWalk
    case capture
    case encode
    /// Turning an element ID into coordinates, when the action named one.
    case resolve
    /// Counters about the tree walk rather than durations: the depth it used,
    /// how many elements it visited, and 1 when it was cut off by that depth.
    case axDepth
    case axElements
    case axTruncated
}

/// Collects the wall time each phase of one `cu.perform` step costs, in whole
/// milliseconds. A reference type so one instance threads through the nested
/// observation builders and every early return still reports what it spent.
/// Main-actor isolated to match the runner, which keeps the measured closures
/// on the same executor and so keeps executor hops out of the measurement.
@MainActor
private final class PhaseTimer {
    private let startedAt = DispatchTime.now()
    private var marks: [String: Int] = [:]

    /// Run `body`, recording how long it took under `phase`. The closure stays
    /// main-actor isolated, so wrapping a call in it changes nothing about
    /// where that call runs.
    func measure<T>(_ phase: CuPhase, _ body: @MainActor () async throws -> T) async rethrows -> T {
        let start = DispatchTime.now()
        defer { record(phase, since: start) }
        return try await body()
    }

    func record(_ phase: CuPhase, millis: Int) {
        marks[phase.rawValue] = millis
    }

    /// Record a phase `measure` cannot wrap, because the value it calls into is
    /// not `Sendable` and so cannot cross into the closure.
    func record(_ phase: CuPhase, since start: DispatchTime) {
        record(phase, millis: Self.millis(since: start))
    }

    /// Whole milliseconds elapsed since `start`.
    nonisolated static func millis(since start: DispatchTime) -> Int {
        Int((DispatchTime.now().uptimeNanoseconds &- start.uptimeNanoseconds) / 1_000_000)
    }

    /// Record everything elapsed since this timer was created, which is the
    /// first line of `perform`.
    func recordTotal() {
        record(.total, since: startedAt)
    }

    /// Zero for a phase that never ran, which keeps the step log readable.
    subscript(phase: CuPhase) -> Int { marks[phase.rawValue] ?? 0 }

    var snapshot: [String: Int] { marks }
}

// MARK: - Action Runner

/// Encapsulates the full host CU action cycle: map tool -> verify -> execute -> wait -> observe.
@MainActor
enum HostCuActionRunner {

    /// Per-session verifier state so safety checks (loop detection, step limits,
    /// "Enter after typing") accumulate across requests within the same session.
    private static var verifiers: [String: ActionVerifier] = [:]

    /// Per-session previous AX elements for computing diffs between steps.
    private static var previousAXElements: [String: [AXElement]] = [:]

    /// Per-session elements of the last tree the model was shown, which is
    /// the numbering its element IDs use. Unlike `previousAXElements` this
    /// includes a scoped read: a window or display observation is no baseline
    /// for a desktop diff, but its IDs are the ones the model acts on next.
    private static var observedElements: [String: [AXElement]] = [:]

    /// Last time each session was touched, for reclaiming state from sessions
    /// that end without a terminal done/respond (cancelled, or conversation
    /// closed mid-flight).
    private static var lastAccess: [String: Date] = [:]

    /// Requests the daemon cancelled while they were running, with when the
    /// cancel arrived. A batch checks this between actions so Stop halts it.
    private static var cancelledRequests: [String: Date] = [:]

    /// Record a cancel for `requestId`. Entries older than a minute are
    /// dropped, which also bounds cancels that arrive after a request ended.
    /// Any cancel means the run has stopped, whether the user pressed Stop or
    /// the task finished (the daemon sends one with an unused ID then), so the
    /// pointer goes back to the user now.
    static func cancel(requestId: String, now: Date = Date()) {
        cancelledRequests = cancelledRequests.filter { now.timeIntervalSince($0.value) < 60 }
        cancelledRequests[requestId] = now
        ActionExecutor.returnPointerHome()
    }

    private static func isCancelled(_ requestId: String) -> Bool {
        cancelledRequests[requestId] != nil
    }

    /// Idle window after which an untouched session's state is reclaimed.
    private static let sessionTTL: TimeInterval = 600

    /// Remove session state when a session ends.
    static func clearSession(_ conversationId: String) {
        verifiers.removeValue(forKey: conversationId)
        previousAXElements.removeValue(forKey: conversationId)
        observedElements.removeValue(forKey: conversationId)
        lastAccess.removeValue(forKey: conversationId)
    }

    /// Evict state for sessions untouched longer than `sessionTTL`, then record
    /// `conversationId` as just-accessed. Bounds memory for abandoned sessions.
    private static func touchSession(_ conversationId: String, now: Date = Date()) {
        for (id, seen) in lastAccess where now.timeIntervalSince(seen) > sessionTTL {
            verifiers.removeValue(forKey: id)
            previousAXElements.removeValue(forKey: id)
            observedElements.removeValue(forKey: id)
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
        let timer = PhaseTimer()
        defer { cancelledRequests.removeValue(forKey: requestId) }
        touchSession(conversationId)
        let enumerator = AccessibilityTreeEnumerator()
        // This tree is a list of things to act on right now, so a row its
        // scroll view is not showing is not one of them. Walking them anyway
        // is what made a Finder window of ~700 files a 7,497-element,
        // 28-second observation. `ax.locate` leaves this off: it has to be
        // able to say "scrolled away" rather than "not found".
        enumerator.skipClippedSubtrees = true
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
        let captureTarget = captureTarget(from: input)
        let includeScreenshot = ObservationCapture.includeScreenshot(from: input["includeScreenshot"])
        let fullTree = AXDepthPolicy.fullTreeRequested(from: input["full_tree"])

        var executionResult: String? = nil
        var executionError: String? = nil

        // Every exit runs through here, so a blocked or failed step still
        // reports where its time went.
        func finish(_ observation: ObservationData) -> HostCuResultPayload {
            timer.recordTotal()
            log.info("[\(stepNumber)] \(observation.treeSummary ?? "no AX tree"): total \(timer[.total])ms (axWalk \(timer[.axWalk])ms, capture \(timer[.capture])ms)")
            return buildResultPayload(
                requestId: requestId,
                conversationId: conversationId,
                observation: observation,
                timings: timer.snapshot
            )
        }

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
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }

            // Stand down while the person at the machine is using it. Both
            // checks run before the verifier, because it records every action
            // it allows: a refusal banked there would let three of the retries
            // this error asks for trip the repeat detector and block the action
            // for good, long after the user went idle.
            let standDown: () async -> HostCuResultPayload = {
                log.info("[\(stepNumber)] Standing down: the user is using the machine")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: ActionExecutor.userIsActiveMessage,
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }
            if toolName == "computer_use_sequence" || toolName == "cu_sequence" {
                let outcome = await runSequence(
                    requestId: requestId,
                    input: input,
                    reasoning: reasoning,
                    verifier: verifier,
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer
                )
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: outcome.result,
                    executionError: outcome.error,
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }

            // Refuse early when we can, which also skips the AX walk that
            // coordinate resolution would otherwise do on the way to nothing.
            if ActionExecutor.takesOverFromUser(agentAction), ActionExecutor.userIsCurrentlyActive() {
                return await standDown()
            }

            // Resolve element IDs to coordinates if needed
            let resolveStart = DispatchTime.now()
            let resolution = await resolveCoordinatesIfNeeded(
                for: agentAction,
                stepNumber: stepNumber,
                conversationId: conversationId
            )
            if agentAction.resolvedFromElementId != nil || agentAction.resolvedToElementId != nil {
                timer.record(.resolve, since: resolveStart)
            }
            let resolvedAction: AgentAction
            switch resolution {
            case .success(let action):
                resolvedAction = action
            case .failure(let problem):
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: problem.message,
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }

            // Handle done/respond completion signals — skip execution
            if resolvedAction.type == .done {
                clearSession(conversationId)
                ActionExecutor.returnPointerHome()
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }

            if resolvedAction.type == .respond {
                clearSession(conversationId)
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: nil,
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }

            // Check again. Resolution above awaits an accessibility walk that
            // can run for seconds, and the machine is not ours during it, so a
            // person who started typing midway through would otherwise be
            // interrupted by an action cleared before they touched anything.
            if ActionExecutor.takesOverFromUser(resolvedAction), ActionExecutor.userIsCurrentlyActive() {
                return await standDown()
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
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)

            case .blocked(let reason):
                log.warning("[\(stepNumber)] BLOCKED: \(reason)")
                let obs = await buildObservation(
                    enumerator: enumerator,
                    screenCapture: screenCapture,
                    executionResult: nil,
                    executionError: "BLOCKED: \(reason)",
                    stepNumber: stepNumber,
                    conversationId: conversationId,
                    timer: timer,
                    includeScreenshot: includeScreenshot
                )
                return finish(obs)
            }

            // EXECUTE
            let executeStart = DispatchTime.now()
            do {
                executionResult = try await executor.execute(resolvedAction)
            } catch {
                let errorMessage = error.localizedDescription
                if resolvedAction.type == .runAppleScript {
                    log.warning("[\(stepNumber)] AppleScript error (non-fatal): \(errorMessage)")
                }
                executionError = errorMessage
            }
            timer.record(.execute, since: executeStart)

            // WAIT — brief delay to let the UI settle after action
            do {
                try await timer.measure(.settle) {
                    try await Task.sleep(nanoseconds: 300_000_000) // 300ms
                }
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
            conversationId: conversationId,
            timer: timer,
            captureTarget: captureTarget,
            includeScreenshot: includeScreenshot,
            fullTree: fullTree
        )

        return finish(obs)
    }

    // MARK: - Sequence

    /// Run a `computer_use_sequence` batch: each action goes through the same
    /// gate, resolution, verification and settle as a single step, in order,
    /// stopping at the first one that is refused or fails. The caller takes
    /// one observation afterwards. Element IDs resolve against the last
    /// observation, which is the tree the model chose them from, and each
    /// click checks its element is still there, since an earlier action in
    /// the batch can have moved it.
    private static func runSequence(
        requestId: String,
        input: [String: Any],
        reasoning: String?,
        verifier: ActionVerifier,
        stepNumber: Int,
        conversationId: String,
        timer: PhaseTimer
    ) async -> (result: String?, error: String?) {
        let items = input["actions"] as? [[String: Any]] ?? []
        let names = items.map { $0["action"] as? String }
        if let problem = ActionSequence.problem(withActions: names) {
            return (nil, problem)
        }
        let actions = zip(items, names).map { item, name in
            mapToAgentAction(
                toolName: ActionSequence.toolName(forAction: name!)!,
                input: item,
                reasoning: item["reasoning"] as? String ?? reasoning
            )
        }

        var ran: [String] = []
        var stoppedAt: String?
        var executeMs = 0
        var settleMs = 0
        var resolveMs = 0

        actionLoop: for (index, action) in actions.enumerated() {
            let label = "action \(index + 1) of \(actions.count) (\(names[index]!))"

            if isCancelled(requestId) {
                stoppedAt = "Stopped at \(label): the request was cancelled."
                break actionLoop
            }

            if ActionExecutor.takesOverFromUser(action), ActionExecutor.userIsCurrentlyActive() {
                stoppedAt = "Stopped at \(label): \(ActionExecutor.userIsActiveMessage)"
                break actionLoop
            }
            let resolveStart = DispatchTime.now()
            let resolution = await resolveCoordinatesIfNeeded(
                for: action,
                stepNumber: stepNumber,
                conversationId: conversationId
            )
            resolveMs += PhaseTimer.millis(since: resolveStart)
            let resolved: AgentAction
            switch resolution {
            case .success(let action):
                resolved = action
            case .failure(let problem):
                stoppedAt = "Stopped at \(label): \(problem.message)"
                break actionLoop
            }
            if ActionExecutor.takesOverFromUser(resolved), ActionExecutor.userIsCurrentlyActive() {
                stoppedAt = "Stopped at \(label): \(ActionExecutor.userIsActiveMessage)"
                break actionLoop
            }
            switch verifier.verify(resolved, batchItem: index > 0) {
            case .allowed:
                break
            case .needsConfirmation(let reason):
                stoppedAt = "Stopped at \(label): BLOCKED: \(reason) (confirmation not available in proxy mode)"
                break actionLoop
            case .blocked(let reason):
                stoppedAt = "Stopped at \(label): BLOCKED: \(reason)"
                break actionLoop
            }

            // A fresh executor per action: it is not Sendable, so one instance
            // cannot be sent across the actor boundary on every iteration. Its
            // shared state (the last synthetic post) is static.
            let executor = ActionExecutor()
            let executeStart = DispatchTime.now()
            do {
                let result = try await executor.execute(resolved)
                ran.append(result ?? names[index]!)
            } catch {
                executeMs += PhaseTimer.millis(since: executeStart)
                stoppedAt = "Stopped at \(label): \(error.localizedDescription)"
                break actionLoop
            }
            executeMs += PhaseTimer.millis(since: executeStart)

            let settleStart = DispatchTime.now()
            try? await Task.sleep(nanoseconds: 300_000_000)
            settleMs += PhaseTimer.millis(since: settleStart)
        }

        timer.record(.execute, millis: executeMs)
        timer.record(.settle, millis: settleMs)
        if resolveMs > 0 { timer.record(.resolve, millis: resolveMs) }
        log.info("[\(stepNumber)] Sequence ran \(ran.count) of \(actions.count) actions")

        let summary = ran.isEmpty ? nil : "Ran \(ran.count) of \(actions.count) actions: \(ran.joined(separator: "; "))"
        guard let stoppedAt else { return (summary, nil) }
        let tail = ran.isEmpty ? " Nothing before it ran." : " The \(ran.count) action(s) before it ran."
        return (summary, stoppedAt + tail)
    }

    // MARK: - Capture Target

    /// What an observe request asks to read, when it asks for less than the
    /// main display. The daemon carries the companion's pick as exactly one
    /// of these keys; a window wins over a display should both ever arrive.
    private static func captureTarget(from input: [String: Any]) -> CaptureTarget? {
        if let windowId = (input["captureWindowId"] as? NSNumber)?.uint32Value {
            return .window(windowId)
        }
        if let displayId = (input["captureDisplayId"] as? NSNumber)?.uint32Value {
            return .display(displayId)
        }
        return nil
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

    /// Resolve element IDs to screen coordinates when x/y are not provided. A
    /// click checks that its element is still under that point first.
    private static func resolveCoordinatesIfNeeded(
        for action: AgentAction,
        stepNumber: Int,
        conversationId: String
    ) async -> Result<AgentAction, CoordinateProblem> {
        var resolved = action

        switch resolved.type {
        case .click, .doubleClick, .rightClick:
            if resolved.x == nil || resolved.y == nil {
                guard let sourceId = resolved.resolvedFromElementId else {
                    log.error("[\(stepNumber)] Action requires either x/y coordinates or element_id")
                    return .failure(.missingTarget(resolved.type))
                }
                guard let element = observedElement(sourceId, conversationId: conversationId) else {
                    log.error("[\(stepNumber)] Could not resolve element_id [\(sourceId)]")
                    return .failure(.unknownElement(sourceId))
                }
                let center = CGPoint(x: element.frame.midX, y: element.frame.midY)
                if case .differentElement(let found) = await clickVerdict(for: element, at: center) {
                    log.warning("[\(stepNumber)] Element [\(sourceId)] \(element.role, privacy: .public) is no longer under its point; \(found.role, privacy: .public) is")
                    return .failure(.elementChanged(id: sourceId, observed: element, found: found))
                }
                resolved.x = center.x
                resolved.y = center.y
            }

        case .scroll:
            if (resolved.x == nil || resolved.y == nil), let sourceId = resolved.resolvedFromElementId {
                guard let element = observedElement(sourceId, conversationId: conversationId) else {
                    log.error("[\(stepNumber)] Could not resolve element_id [\(sourceId)]")
                    return .failure(.unknownElement(sourceId))
                }
                resolved.x = element.frame.midX
                resolved.y = element.frame.midY
            }

        case .drag:
            if resolved.x == nil || resolved.y == nil, let sourceId = resolved.resolvedFromElementId,
               let element = observedElement(sourceId, conversationId: conversationId) {
                resolved.x = element.frame.midX
                resolved.y = element.frame.midY
            }
            if resolved.toX == nil || resolved.toY == nil, let targetId = resolved.resolvedToElementId,
               let element = observedElement(targetId, conversationId: conversationId) {
                resolved.toX = element.frame.midX
                resolved.toY = element.frame.midY
            }

        default:
            break
        }

        return .success(resolved)
    }

    /// Why an action could not be given screen coordinates. The message reaches
    /// the model as `executionError`, so it names what to send instead.
    enum CoordinateProblem: Error {
        case missingTarget(ActionType)
        case unknownElement(Int)
        case elementChanged(id: Int, observed: AXElement, found: AXClickTarget.Element)

        var message: String {
            switch self {
            case .missingTarget(let type):
                return "\(type.rawValue) needs element_id, or x and y. Nothing was done."
            case .unknownElement(let id):
                return "Element [\(id)] is not in the latest observation. Nothing was done. Observe again and use an ID from that tree, or pass x and y."
            case .elementChanged(let id, let observed, let found):
                let x = Int(observed.frame.midX)
                let y = Int(observed.frame.midY)
                return "Element [\(id)] \(Self.describe(role: observed.role, label: observed.title)) is no longer at (\(x), \(y)); \(Self.describe(role: found.role, label: found.label)) is there now. Nothing was done. Observe again and use an ID from that tree, or pass x and y for what the screenshot shows."
            }
        }

        private static func describe(role: String, label: String?) -> String {
            let name = AccessibilityTreeEnumerator.cleanRole(role)
            guard let label else { return name }
            return "\(name) \"\(AXLabel.singleLine(label))\""
        }
    }

    /// The element `elementId` names in the last tree the model was shown.
    /// Nothing else is searched: a fresh walk numbers its elements from
    /// scratch, so the same number there can be a different control.
    private static func observedElement(_ elementId: Int, conversationId: String) -> AXElement? {
        observedElements[conversationId]?.first(where: { $0.id == elementId })
    }

    /// How long to wait before asking again when the first hit test settled
    /// nothing. Chromium answers a hit test at once with the root of its web
    /// content and resolves the real element in the background: measured on
    /// Slack, 3 of 62 controls were found on the first ask and 52 on a second
    /// ask 20ms later, with no gain from waiting 100ms.
    private static let hitTestRetryNanoseconds: UInt64 = 30_000_000

    /// What accessibility says is under `point` now, judged against `element`.
    private static func clickVerdict(for element: AXElement, at point: CGPoint) async -> AXClickTarget.Verdict {
        let target = AXClickTarget.Element(
            role: element.role,
            label: element.title,
            frame: element.frame,
            actionable: AccessibilityTreeEnumerator.interactiveRoles.contains(element.role)
        )
        let verdict = AXClickTarget.verdict(
            target: target,
            hitChain: await AccessibilityTreeEnumerator.hitChain(at: point)
        )
        guard verdict == .unknown else { return verdict }
        try? await Task.sleep(nanoseconds: hitTestRetryNanoseconds)
        return AXClickTarget.verdict(
            target: target,
            hitChain: await AccessibilityTreeEnumerator.hitChain(at: point)
        )
    }

    // MARK: - Observation Builder

    /// Internal observation data before packaging into the result payload.
    private struct ObservationData {
        let axTree: String?
        let axDiff: String?
        let currentElements: [AXElement]?
        /// Every element of the tree that was read, scoped or not.
        let shownElements: [AXElement]?
        let screenshot: String?
        let screenshotWidthPx: Int?
        let screenshotHeightPx: Int?
        let screenWidthPt: Int?
        let screenHeightPt: Int?
        let executionResult: String?
        let executionError: String?
        /// One-line description of the tree that was read, for the step log.
        /// Nil when no tree was available.
        let treeSummary: String?
    }

    /// One window's AX read: its elements plus the identity of the window they came from.
    private typealias WindowRead = (elements: [AXElement], windowTitle: String, appName: String, pid: pid_t)

    /// Take the observation screenshot and report how long the capture itself
    /// took, so a caller running it beside other work can record it honestly.
    nonisolated private static func timedCapture(
        _ screenCapture: any ScreenCaptureProviding,
        target: CaptureTarget?
    ) async -> (Result<ScreenCaptureResult, any Error>, Int) {
        let start = DispatchTime.now()
        do {
            let result = try await screenCapture.captureScreenWithMetadata(maxWidth: 960, maxHeight: 540, target: target)
            return (.success(result), PhaseTimer.millis(since: start))
        } catch {
            return (.failure(error), PhaseTimer.millis(since: start))
        }
    }

    /// Capture the current screen state as an observation. With
    /// `includeScreenshot` false and no `captureTarget`, a readable tree is
    /// returned without a screenshot.
    private static func buildObservation(
        enumerator: AccessibilityTreeEnumerator,
        screenCapture: ScreenCaptureProviding,
        executionResult: String?,
        executionError: String?,
        stepNumber: Int,
        conversationId: String,
        timer: PhaseTimer,
        captureTarget: CaptureTarget? = nil,
        includeScreenshot: Bool = true,
        fullTree: Bool = false
    ) async -> ObservationData {
        var axTreeText: String?
        var axDiffText: String?
        var currentElements: [AXElement]?
        var shownElements: [AXElement]?
        var screenshotBase64: String?
        var screenshotWidthPx: Int?
        var screenshotHeightPx: Int?
        var screenWidthPt: Int?
        var screenHeightPt: Int?
        var treeSummary: String?

        // Targeted reads are standalone snapshots, never a desktop diff baseline.
        // Clear before enumeration, including failed/missing-window captures, so
        // the next ordinary observation also starts with a fresh baseline.
        if captureTarget != nil {
            previousAXElements.removeValue(forKey: conversationId)
            observedElements.removeValue(forKey: conversationId)
        }

        // The tree stays inside what the screenshot shows. A window target
        // reads that window's tree, focused or not; a display target reads
        // the frontmost window on that display. Neither falls back to the
        // focused window: it may be on another display or another app, and
        // its text would then be filed against a frame that never showed it.
        // A targeted read with no matching tree is a screenshot alone.
        // A wanted screenshot starts before the AX walk so the two overlap: they
        // read the same moment of the same screen through different subsystems,
        // and neither needs the other's answer. The request is identical whether
        // or not the walk finds a tree, so one call serves both outcomes. When
        // the daemon opts out of an unscoped screenshot, this task returns nil
        // at once and the capture waits on whether the walk finds a tree.
        let capturePlan = ObservationCapture.plan(includeScreenshot: includeScreenshot, scoped: captureTarget != nil)
        async let concurrentShot = capturePlan == .besideWalk
            ? timedCapture(screenCapture, target: captureTarget)
            : nil

        func walk(depth: Int) async -> WindowRead? {
            enumerator.depthLimit = depth
            switch captureTarget {
            case .window(let windowId):
                return await enumerator.enumerateWindow(windowId: windowId)
            case .display(let displayId):
                guard let windowId = CaptureSources.topmostWindowId(onDisplay: displayId) else { return nil }
                return await enumerator.enumerateWindow(windowId: windowId)
            case nil:
                return await enumerator.enumerateCurrentWindow()
            }
        }
        func interactiveCount(_ read: WindowRead) -> Int {
            AccessibilityTreeEnumerator.flattenElements(read.elements)
                .filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
        }

        // Walk shallow first. Only a walk that was cut off and found nothing to
        // act on goes deeper on its own; otherwise the observation says it was
        // cut off and the model asks for the full tree if it needs it.
        let walkStart = DispatchTime.now()
        var depth = AXDepthPolicy.startingDepth(fullTreeRequested: fullTree)
        var windowResult = await walk(depth: depth)
        if let read = windowResult,
           let deeper = AXDepthPolicy.retryDepth(
               after: depth,
               truncated: enumerator.lastWalkTruncated,
               interactiveCount: interactiveCount(read)
           ) {
            depth = deeper
            windowResult = await walk(depth: depth)
        }
        timer.record(.axWalk, since: walkStart)
        let walkTruncated = enumerator.lastWalkTruncated
        timer.record(.axDepth, millis: depth)
        timer.record(.axElements, millis: enumerator.lastWalkElementCount)
        timer.record(.axTruncated, millis: walkTruncated ? 1 : 0)

        if let result = windowResult {
            axTreeText = AccessibilityTreeEnumerator.formatAXTree(
                elements: result.elements,
                windowTitle: result.windowTitle,
                appName: result.appName,
                clippedDuringWalk: enumerator.lastWalkClippedCount
            )
            if walkTruncated {
                axTreeText? += depth < AXDepthPolicy.fullDepth
                    ? "\n\n(Tree cut off at depth \(depth). Call computer_use_observe with full_tree: true to see deeper elements.)"
                    : "\n\n(Tree cut off at depth \(depth), the deepest walk available. Elements below it are not listed; use a screenshot to see them.)"
            }
            let flat = AccessibilityTreeEnumerator.flattenElements(result.elements)
            currentElements = captureTarget == nil ? flat : nil
            shownElements = flat
            let interactiveCount = flat.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }.count
            treeSummary = "AX tree: \(result.appName) \"\(result.windowTitle)\", \(flat.count) elements (\(interactiveCount) interactive)"

            // Compute AX diff against previous step's elements
            if captureTarget == nil, let previousFlat = previousAXElements[conversationId] {
                axDiffText = AXTreeDiff.diff(previousFlat: previousFlat, currentFlat: flat)
            }

        } else {
            log.warning("[\(stepNumber)] No AX tree available, using the screenshot alone")
        }

        // Collect the capture that ran alongside the walk. A skipped screenshot
        // is taken now after all when the walk found no tree, since the model
        // would otherwise see nothing.
        var timedShot = await concurrentShot
        if capturePlan.captureAfterWalk(treeFound: windowResult != nil) {
            log.info("[\(stepNumber)] Screenshot skip overridden: no AX tree to return instead")
            timedShot = await timedCapture(screenCapture, target: captureTarget)
        }

        // A failure still leaves the screenshot nil and the tree, if there is
        // one, intact. The duration was measured inside the capture, so it
        // reports the capture alone rather than however long the walk beside it
        // took. A skipped capture records 0.
        if let (captureOutcome, captureMs) = timedShot {
            timer.record(.capture, millis: captureMs)
            switch captureOutcome {
            case .success(let screenshotResult):
                screenshotBase64 = await timer.measure(.encode) {
                    screenshotResult.jpegData.base64EncodedString()
                }
                if let meta = screenshotResult.metadata {
                    screenshotWidthPx = meta.screenshotWidthPx
                    screenshotHeightPx = meta.screenshotHeightPx
                }
                let screenSize = screenCapture.screenSize()
                screenWidthPt = Int(screenSize.width)
                screenHeightPt = Int(screenSize.height)
            case .failure(let error):
                log.error("[\(stepNumber)] Screenshot capture failed: \(error)")
            }
        } else {
            timer.record(.capture, millis: 0)
        }

        return ObservationData(
            axTree: axTreeText,
            axDiff: axDiffText,
            currentElements: currentElements,
            shownElements: shownElements,
            screenshot: screenshotBase64,
            screenshotWidthPx: screenshotWidthPx,
            screenshotHeightPx: screenshotHeightPx,
            screenWidthPt: screenWidthPt,
            screenHeightPt: screenHeightPt,
            executionResult: executionResult,
            executionError: executionError,
            treeSummary: treeSummary
        )
    }

    /// Package observation data into a `HostCuResultPayload` and update previous AX state.
    private static func buildResultPayload(
        requestId: String,
        conversationId: String,
        observation: ObservationData,
        timings: [String: Int]?
    ) -> HostCuResultPayload {
        // Update previous AX elements for next step's diff
        if let elements = observation.currentElements {
            previousAXElements[conversationId] = elements
        }
        if let elements = observation.shownElements {
            observedElements[conversationId] = elements
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
            timings: timings
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
