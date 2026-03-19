import SwiftUI
import AppKit

/// Live-rendered avatar using CAShapeLayer, enabling future animations
/// (blink, ripple, bounce). Renders identically to AvatarCompositor's
/// static bitmap output for the same body/eyes/color combination.
struct AnimatedAvatarView: View {
    let bodyShape: AvatarBodyShape
    let eyeStyle: AvatarEyeStyle
    let color: AvatarColor
    let size: CGFloat
    var breathingEnabled: Bool = true
    var blinkEnabled: Bool = true
    var pokeEnabled: Bool = true
    var entryAnimationEnabled: Bool = false

    @State private var isHovered = false

    var body: some View {
        AvatarLayerRepresentable(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size,
                                 breathingEnabled: breathingEnabled, blinkEnabled: blinkEnabled, pokeEnabled: pokeEnabled,
                                 entryAnimationEnabled: entryAnimationEnabled,
                                 isHovered: isHovered)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

private struct AvatarLayerRepresentable: NSViewRepresentable {
    let bodyShape: AvatarBodyShape
    let eyeStyle: AvatarEyeStyle
    let color: AvatarColor
    let size: CGFloat
    var breathingEnabled: Bool = true
    var blinkEnabled: Bool = true
    var pokeEnabled: Bool = true
    var entryAnimationEnabled: Bool = false
    var isHovered: Bool = false

    func makeNSView(context: Context) -> AvatarLayerView {
        let view = AvatarLayerView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size,
                       breathingEnabled: breathingEnabled, blinkEnabled: blinkEnabled, pokeEnabled: pokeEnabled,
                       entryAnimationEnabled: entryAnimationEnabled)
        view.updateHoverState(isHovered)
        return view
    }

    func updateNSView(_ nsView: AvatarLayerView, context: Context) {
        nsView.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size,
                         breathingEnabled: breathingEnabled, blinkEnabled: blinkEnabled, pokeEnabled: pokeEnabled,
                         entryAnimationEnabled: entryAnimationEnabled)
        nsView.updateHoverState(isHovered)
    }
}

class AvatarLayerView: NSView {
    private var bodyLayer = CAShapeLayer()
    private var eyeLayers: [CAShapeLayer] = []

    /// Track current configuration to skip redundant updates.
    private var currentKey: String?

    /// Pre-computed open and closed eye CGPaths for blink animation.
    private var openEyePaths: [CGPath] = []
    private var closedEyePaths: [CGPath] = []
    private var widenedEyePaths: [CGPath] = []
    private var isHovered = false

    /// Timer that fires random blinks.
    private var blinkTask: Task<Void, Never>?

    /// Timer that fires random twitches.
    private var twitchTask: Task<Void, Never>?

    /// Task for the delayed start of breathing/blink/twitch after entry animation.
    private var postEntryTask: Task<Void, Never>?

    /// Whether animations are currently active (paused when window is inactive).
    private var animationsActive = true

    /// Per-animation config flags (set via `configure()`).
    private var configBreathingEnabled: Bool = true
    private var configBlinkEnabled: Bool = true
    private var configPokeEnabled: Bool = true
    private var configEntryAnimationEnabled: Bool = false
    private var hasPlayedEntry: Bool = false

    /// Whether configure() has set up entry animation state (closed eyes, drop transform)
    /// that needs to be cleaned up if the entry animation never fires.
    private var entrySetupPending: Bool = false

    /// Notification observers for window key/resign-key events.
    private var notificationObservers: [NSObjectProtocol] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(bodyLayer)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func resetCursorRects() {
        if configPokeEnabled {
            addCursorRect(bounds, cursor: .pointingHand)
        }
    }

    /// Called from SwiftUI's `.onHover` via the representable bridge.
    /// Animates eye paths between widened (hovered) and normal (not hovered).
    func updateHoverState(_ hovered: Bool) {
        guard hovered != isHovered else { return }
        isHovered = hovered

        if hovered {
            guard animationsActive else { isHovered = false; return }
            guard !eyeLayers.isEmpty,
                  eyeLayers.count == widenedEyePaths.count else { return }

            for (i, eyeLayer) in eyeLayers.enumerated() {
                let animation = CABasicAnimation(keyPath: "path")
                animation.fromValue = eyeLayer.path
                animation.toValue = widenedEyePaths[i]
                animation.duration = 0.12
                animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
                eyeLayer.path = widenedEyePaths[i]
                eyeLayer.add(animation, forKey: "eyeWiden")
            }
        } else {
            guard !eyeLayers.isEmpty,
                  eyeLayers.count == openEyePaths.count else { return }

            for (i, eyeLayer) in eyeLayers.enumerated() {
                let animation = CABasicAnimation(keyPath: "path")
                animation.fromValue = eyeLayer.path
                animation.toValue = openEyePaths[i]
                animation.duration = 0.2
                animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                eyeLayer.path = openEyePaths[i]
                eyeLayer.add(animation, forKey: "eyeWiden")
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        performPoke()
    }

    deinit {
        blinkTask?.cancel()
        twitchTask?.cancel()
        postEntryTask?.cancel()
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func configure(bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor, size: CGFloat,
                   breathingEnabled: Bool = true, blinkEnabled: Bool = true, pokeEnabled: Bool = true,
                   entryAnimationEnabled: Bool = false) {
        configBreathingEnabled = breathingEnabled
        configBlinkEnabled = blinkEnabled
        let pokeChanged = configPokeEnabled != pokeEnabled
        configPokeEnabled = pokeEnabled
        configEntryAnimationEnabled = entryAnimationEnabled

        // When pokeEnabled changes, AppKit won't re-invoke resetCursorRects()
        // on its own (the frame hasn't changed), so we must explicitly ask it
        // to re-query cursor rects for this view.
        if pokeChanged {
            window?.invalidateCursorRects(for: self)
        }

        // Recovery: if entry was set up but entryAnimationEnabled was turned off
        // (e.g. SwiftUI re-rendered with entryAnimationEnabled=false before
        // viewDidMoveToWindow fired), reset the avatar to its normal state.
        if entrySetupPending && !configEntryAnimationEnabled {
            entrySetupPending = false
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.transform = CATransform3DIdentity
            for (i, eyeLayer) in eyeLayers.enumerated() where i < openEyePaths.count {
                eyeLayer.path = openEyePaths[i]
            }
            CATransaction.commit()
            if animationsActive {
                if configBlinkEnabled { startBlinkTimer() }
                if configBreathingEnabled { startBreathing() }
                startTwitchTimer()
            }
        }

        let key = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)-\(color.rawValue)-\(String(format: "%.1f", size))-\(breathingEnabled)-\(blinkEnabled)-\(pokeEnabled)"
        guard key != currentKey else { return }
        currentKey = key

        // Update frame
        frame = NSRect(x: 0, y: 0, width: size, height: size)

        // Disable implicit CALayer animations during configuration
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        // --- Body layer ---
        let bodyViewBox = bodyShape.viewBox
        let bodyTransform = AvatarTransforms.bodyTransform(viewBox: bodyViewBox, outputSize: size)
        let bodyEditable = parseSVGPathToEditable(bodyShape.svgPath)
        let bodyCGPath = bodyEditable.toCGPath()

        var mutableTransform = bodyTransform
        bodyLayer.path = (bodyViewBox.width > 0 && bodyViewBox.height > 0)
            ? bodyCGPath.copy(using: &mutableTransform) : nil
        bodyLayer.fillColor = color.nsColor.cgColor
        bodyLayer.frame = CGRect(x: 0, y: 0, width: size, height: size)

        // Anchor scale from the center of the body layer so breathing animates symmetrically
        bodyLayer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        bodyLayer.position = CGPoint(x: frame.width / 2, y: frame.height / 2)

        // --- Eye layers ---
        // Remove old eye layers
        for layer in eyeLayers { layer.removeFromSuperlayer() }
        eyeLayers.removeAll()

        // Pre-compute blink paths
        openEyePaths.removeAll()
        closedEyePaths.removeAll()
        widenedEyePaths.removeAll()

        let eyeSourceViewBox = eyeStyle.sourceViewBox
        let faceCenter = AvatarTransforms.resolveFaceCenter(bodyShape: bodyShape, eyeStyle: eyeStyle)
        if bodyViewBox.width > 0, bodyViewBox.height > 0,
           eyeSourceViewBox.width > 0, eyeSourceViewBox.height > 0 {
            let eyeXform = AvatarTransforms.eyeTransform(
                eyeSourceViewBox: eyeSourceViewBox,
                eyeCenter: eyeStyle.eyeCenter,
                bodyViewBox: bodyViewBox,
                faceCenter: faceCenter,
                bodyTransform: bodyTransform
            )

            for eyePath in eyeStyle.paths {
                let eyeEditable = parseSVGPathToEditable(eyePath.svgPath)
                let eyeCGPath = eyeEditable.toCGPath()
                var mutableEyeTransform = eyeXform
                guard let transformedEyePath = eyeCGPath.copy(using: &mutableEyeTransform) else { continue }

                // Closed path — squish Y toward center, then apply same transform
                let closedEditable = eyeEditable.blinked(amount: 1.0)
                let closedCGPath = closedEditable.toCGPath()
                var closedTransform = eyeXform
                guard let closedPath = closedCGPath.copy(using: &closedTransform) else { continue }

                // Widened path — expand Y away from center for alert/hover look
                let widenedEditable = eyeEditable.blinked(amount: -0.15)
                let widenedCGPath = widenedEditable.toCGPath()
                var widenedTransform = eyeXform
                guard let widenedPath = widenedCGPath.copy(using: &widenedTransform) else { continue }

                let eyeLayer = CAShapeLayer()
                eyeLayer.path = transformedEyePath
                eyeLayer.fillColor = eyePath.color.cgColor
                eyeLayer.frame = CGRect(x: 0, y: 0, width: size, height: size)
                layer?.addSublayer(eyeLayer)
                eyeLayers.append(eyeLayer)

                openEyePaths.append(transformedEyePath)
                closedEyePaths.append(closedPath)
                widenedEyePaths.append(widenedPath)
            }
        }

        // If hovered during reconfiguration, apply widened paths immediately (no animation)
        if isHovered {
            for (i, eyeLayer) in eyeLayers.enumerated() where i < widenedEyePaths.count {
                eyeLayer.path = widenedEyePaths[i]
            }
        }

        CATransaction.commit()

        if configEntryAnimationEnabled && !hasPlayedEntry {
            entrySetupPending = true
            // Set initial "water drop" state — slightly narrow and tall
            layer?.transform = CATransform3DMakeScale(0.7, 1.3, 1.0)
            // Eyes start squeezed shut — they animate open during the bounce-back
            for (i, eyeLayer) in eyeLayers.enumerated() where i < closedEyePaths.count {
                eyeLayer.path = closedEyePaths[i]
            }
            // Don't start breathing/blink/twitch yet — they start after entry completes
        } else {
            if animationsActive {
                if configBlinkEnabled { startBlinkTimer() }
                if configBreathingEnabled { startBreathing() }
                startTwitchTimer()
            }
        }
    }

    private func startBlinkTimer() {
        blinkTask?.cancel()
        blinkTask = Task { [weak self] in
            while !Task.isCancelled {
                // Random delay between 3-7 seconds
                let delay = Double.random(in: 3.0...7.0)
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self, self.animationsActive, self.configBlinkEnabled else { return }
                    self.performBlink()
                }
            }
        }
    }

    private func startTwitchTimer() {
        twitchTask?.cancel()
        twitchTask = Task { [weak self] in
            while !Task.isCancelled {
                let delay = Double.random(in: 8.0...15.0)
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self, self.animationsActive else { return }
                    self.performTwitch()
                }
            }
        }
    }

    private func performTwitch() {
        guard animationsActive else { return }
        guard let rootLayer = layer else { return }

        rootLayer.removeAnimation(forKey: "twitch")

        let animation = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        let baseAngle: CGFloat = .random(in: (.pi / 150)...(.pi / 90))  // ~1.2° to ~2°
        let sign: CGFloat = Bool.random() ? 1.0 : -1.0  // Random CW or CCW start
        let angle = baseAngle * sign
        animation.values = [0, angle, -angle * 0.6, angle * 0.3, 0]
        animation.keyTimes = [0, 0.2, 0.5, 0.75, 1.0]
        animation.duration = 0.4
        animation.timingFunctions = [
            CAMediaTimingFunction(name: .easeIn),
            CAMediaTimingFunction(name: .easeOut),
            CAMediaTimingFunction(name: .easeInEaseOut),
            CAMediaTimingFunction(name: .easeOut),
        ]
        animation.isRemovedOnCompletion = true
        rootLayer.add(animation, forKey: "twitch")
    }

    private func startBreathing() {
        bodyLayer.removeAnimation(forKey: "breathing")

        let breathe = CABasicAnimation(keyPath: "transform.scale")
        breathe.fromValue = 1.0
        breathe.toValue = 1.03  // 3% expansion
        breathe.duration = 2.0  // 2s inhale
        breathe.autoreverses = true  // 2s exhale
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        bodyLayer.add(breathe, forKey: "breathing")
    }

    // MARK: - Window-aware lifecycle

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        // Clean up old observers
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        notificationObservers.removeAll()

        guard let window else {
            pauseAnimations()
            return
        }

        // Entry animation: play once when view first appears in a window
        if configEntryAnimationEnabled && !hasPlayedEntry {
            hasPlayedEntry = true
            animationsActive = true

            let keyObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didBecomeKeyNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                self?.resumeAnimations()
            }
            let resignKeyObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didResignKeyNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                self?.pauseAnimations()
            }
            notificationObservers = [keyObserver, resignKeyObserver]

            // Trigger entry after a runloop tick so the view is laid out
            DispatchQueue.main.async { [weak self] in
                self?.performEntryAnimation()
            }
            return
        }

        // Safety: if entry state was set up but we're now taking the normal path
        // (e.g. configEntryAnimationEnabled was cleared), ensure the avatar is
        // in its normal visual state.
        if entrySetupPending {
            entrySetupPending = false
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.transform = CATransform3DIdentity
            for (i, eyeLayer) in eyeLayers.enumerated() where i < openEyePaths.count {
                eyeLayer.path = openEyePaths[i]
            }
            CATransaction.commit()
        }

        let keyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didBecomeKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            self?.resumeAnimations()
        }
        let resignKeyObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            self?.pauseAnimations()
        }
        notificationObservers = [keyObserver, resignKeyObserver]

        // Start in correct state
        if window.isKeyWindow {
            resumeAnimations()
        } else {
            pauseAnimations()
        }
    }

    private func pauseAnimations() {
        animationsActive = false
        blinkTask?.cancel()
        twitchTask?.cancel()
        postEntryTask?.cancel()
        if configBreathingEnabled {
            let pausedTime = bodyLayer.convertTime(CACurrentMediaTime(), from: nil)
            bodyLayer.speed = 0
            bodyLayer.timeOffset = pausedTime
        }
    }

    private func resumeAnimations() {
        animationsActive = true
        if configBlinkEnabled { startBlinkTimer() }
        startTwitchTimer()
        if configBreathingEnabled {
            let pausedTime = bodyLayer.timeOffset
            bodyLayer.speed = 1
            bodyLayer.timeOffset = 0
            bodyLayer.beginTime = 0
            let timeSincePause = bodyLayer.convertTime(CACurrentMediaTime(), from: nil) - pausedTime
            bodyLayer.beginTime = timeSincePause
        }
    }

    private func performPoke() {
        guard animationsActive, configPokeEnabled else { return }
        guard let rootLayer = layer else { return }

        // Remove any in-progress poke animation (enables interruptible rapid clicks)
        rootLayer.removeAnimation(forKey: "poke")

        let animation = CAKeyframeAnimation(keyPath: "transform")

        // Squash-and-spring keyframes:
        // 1. Impact: quick squash (compress vertically, expand horizontally for volume preservation)
        // 2. Rebound: spring back with overshoot
        // 3. Settle: damped oscillation back to rest
        let identity = CATransform3DIdentity
        let squash = CATransform3DMakeScale(1.08, 0.88, 1.0)     // Hit: wide + short
        let stretch = CATransform3DMakeScale(0.97, 1.04, 1.0)     // Overshoot: narrow + tall
        let settle = CATransform3DMakeScale(1.01, 0.99, 1.0)      // Slight undershoot

        animation.values = [
            NSValue(caTransform3D: identity),   // Start: normal
            NSValue(caTransform3D: squash),      // Impact: squashed
            NSValue(caTransform3D: stretch),     // Rebound: overshoot
            NSValue(caTransform3D: settle),      // Settle: slight undershoot
            NSValue(caTransform3D: identity),    // Rest: back to normal
        ]
        animation.keyTimes = [0, 0.15, 0.45, 0.72, 1.0]
        animation.duration = 0.45
        animation.timingFunctions = [
            CAMediaTimingFunction(name: .easeIn),       // Quick squash
            CAMediaTimingFunction(name: .easeOut),      // Springy rebound
            CAMediaTimingFunction(name: .easeInEaseOut), // Gentle settle
            CAMediaTimingFunction(name: .easeOut),      // Final ease to rest
        ]
        animation.isRemovedOnCompletion = true
        rootLayer.add(animation, forKey: "poke")
    }

    private func performEntryAnimation() {
        guard let rootLayer = layer else { return }
        entrySetupPending = false

        // --- Body: water-drop with vertical bounces ---
        // Starts slightly tall/narrow (falling drop), squashes on impact, then
        // bounces predominantly in Y so the motion reads as top-down, not side-to-side.
        let bodyAnim = CAKeyframeAnimation(keyPath: "transform")
        let drop     = CATransform3DMakeScale(0.7, 1.3, 1.0)    // Slightly narrow and tall (falling)
        let splat    = CATransform3DMakeScale(1.2, 0.75, 1.0)    // Wide + short on impact
        let bounce1  = CATransform3DMakeScale(0.95, 1.1, 1.0)    // Rebound: mostly taller
        let bounce2  = CATransform3DMakeScale(1.02, 0.96, 1.0)   // Settle: mostly shorter
        let identity = CATransform3DIdentity

        bodyAnim.values = [
            NSValue(caTransform3D: drop),       // Start: falling drop shape
            NSValue(caTransform3D: splat),      // Impact: squash down
            NSValue(caTransform3D: bounce1),    // Rebound: spring up
            NSValue(caTransform3D: bounce2),    // Settle: slight squash
            NSValue(caTransform3D: identity),   // Rest: normal
        ]
        bodyAnim.keyTimes = [0, 0.28, 0.55, 0.78, 1.0]
        bodyAnim.duration = 0.6
        bodyAnim.timingFunctions = [
            CAMediaTimingFunction(name: .easeIn),        // drop → splat (accelerating fall)
            CAMediaTimingFunction(name: .easeOut),        // splat → bounce1 (springy rebound)
            CAMediaTimingFunction(name: .easeInEaseOut),  // bounce1 → bounce2 (damping)
            CAMediaTimingFunction(name: .easeOut),        // bounce2 → rest (smooth finish)
        ]
        bodyAnim.isRemovedOnCompletion = true
        rootLayer.transform = CATransform3DIdentity  // set model to final state
        rootLayer.add(bodyAnim, forKey: "entry")

        // --- Eyes: animate from closed to open (like eyes opening after landing) ---
        // Uses CAAnimation beginTime instead of DispatchQueue.main.asyncAfter to avoid
        // race conditions where the view is reconfigured before the callback fires.
        let eyeOpenDelay: TimeInterval = 0.35  // During first rebound phase
        for (i, eyeLayer) in eyeLayers.enumerated()
            where i < openEyePaths.count && i < closedEyePaths.count {
            eyeLayer.path = openEyePaths[i]  // Model: final open state
            let anim = CABasicAnimation(keyPath: "path")
            anim.fromValue = closedEyePaths[i]
            anim.toValue = openEyePaths[i]
            anim.beginTime = CACurrentMediaTime() + eyeOpenDelay
            anim.duration = 0.2
            anim.fillMode = .backwards  // Show closed eyes until beginTime
            anim.isRemovedOnCompletion = true
            anim.timingFunction = CAMediaTimingFunction(name: .easeOut)
            eyeLayer.add(anim, forKey: "eyeReveal")
        }

        // --- Start other animations after a comfortable pause post-entry ---
        let postEntryDelay: TimeInterval = 1.1  // Entry (0.6s) + breathing pause (0.5s)
        postEntryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(postEntryDelay))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.animationsActive else { return }
                if self.configBlinkEnabled { self.startBlinkTimer() }
                if self.configBreathingEnabled { self.startBreathing() }
                self.startTwitchTimer()
            }
        }
    }

    private func performBlink() {
        guard !eyeLayers.isEmpty,
              eyeLayers.count == openEyePaths.count,
              eyeLayers.count == closedEyePaths.count else { return }

        let isDoubleBlink = Double.random(in: 0...1) < 0.2

        for (i, eyeLayer) in eyeLayers.enumerated() {
            let restPath = isHovered && i < widenedEyePaths.count ? widenedEyePaths[i] : openEyePaths[i]

            let animation: CAKeyframeAnimation
            if isDoubleBlink {
                animation = CAKeyframeAnimation(keyPath: "path")
                animation.values = [
                    restPath,
                    closedEyePaths[i],
                    restPath,
                    closedEyePaths[i],
                    restPath,
                ]
                animation.keyTimes = [0, 0.15, 0.35, 0.50, 1.0]
                animation.duration = 0.45
                animation.timingFunctions = [
                    CAMediaTimingFunction(name: .easeIn),
                    CAMediaTimingFunction(name: .easeOut),
                    CAMediaTimingFunction(name: .easeIn),
                    CAMediaTimingFunction(name: .easeOut),
                ]
            } else {
                animation = CAKeyframeAnimation(keyPath: "path")
                animation.values = [restPath, closedEyePaths[i], restPath]
                animation.keyTimes = [0, 0.3, 1.0]
                animation.duration = 0.25
                animation.timingFunctions = [
                    CAMediaTimingFunction(name: .easeIn),
                    CAMediaTimingFunction(name: .easeOut),
                ]
            }
            animation.isRemovedOnCompletion = true
            eyeLayer.add(animation, forKey: "blink")
        }
    }
}
