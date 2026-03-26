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
    var isStreaming: Bool = false

    @State private var isHovered = false

    var body: some View {
        AvatarLayerRepresentable(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size,
                                 breathingEnabled: breathingEnabled, blinkEnabled: blinkEnabled, pokeEnabled: pokeEnabled,
                                 entryAnimationEnabled: entryAnimationEnabled,
                                 isStreaming: isStreaming,
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
    var isStreaming: Bool = false
    var isHovered: Bool = false

    func makeNSView(context: Context) -> AvatarLayerView {
        let view = AvatarLayerView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size,
                       breathingEnabled: breathingEnabled, blinkEnabled: blinkEnabled, pokeEnabled: pokeEnabled,
                       entryAnimationEnabled: entryAnimationEnabled)
        view.updateHoverState(isHovered)
        view.updateStreamingState(isStreaming)
        return view
    }

    func updateNSView(_ nsView: AvatarLayerView, context: Context) {
        nsView.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size,
                         breathingEnabled: breathingEnabled, blinkEnabled: blinkEnabled, pokeEnabled: pokeEnabled,
                         entryAnimationEnabled: entryAnimationEnabled)
        nsView.updateHoverState(isHovered)
        nsView.updateStreamingState(isStreaming)
    }
}

class AvatarLayerView: NSView {

    // MARK: - Animation & Action Catalog
    //
    // Animations (canonical names — used as CAAnimation keys):
    //   breathing — body scale pulse (inhale/exhale loop)
    //   blink     — eye open/close cycle
    //   twitch    — subtle body rotation wobble
    //   poke      — squash-and-stretch spring on body
    //   widen     — eye path widen/unwiden
    //   entry     — water-drop bounce-in on body
    //   reveal    — eye open during entry (sub-animation of entry action)
    //   morph     — streaming body path wobble + squash/stretch/rotation
    //              (morph.scaleX, morph.scaleY, morph.rotation)
    //
    // Actions (triggers that invoke one or more animations):
    //   hover     → widen
    //   poke      → poke (click)
    //   entry     → entry + reveal, then after delay: breathing, blink, twitch
    //   streaming → morph (pauses breathing while active)

    // MARK: - Properties

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

    /// Whether the post-entry animations (breathing, blink, twitch) have been started
    /// after the entry animation delay. Used by `resumeAnimations()` to decide whether
    /// to start breathing fresh vs resume an existing animation.
    private var postEntryAnimationsStarted: Bool = false

    /// Whether configure() has set up entry animation state (closed eyes, drop transform)
    /// that needs to be cleaned up if the entry animation never fires.
    private var entrySetupPending: Bool = false

    /// Whether the body morphing streaming animation is currently active.
    private var isStreamingActive: Bool = false
    /// Cached current body shape and size for morph path generation.
    private var currentBodyShape: AvatarBodyShape?
    private var currentSize: CGFloat = 0
    /// Pre-computed wobbled body paths for morph animation.
    /// Index 0 is the original shape; remaining indices are wobble variants.
    private var morphPaths: [CGPath] = []
    /// Timer-driven path cycling for the morph animation.
    private var morphTimer: Task<Void, Never>?
    private var morphFrameIndex: Int = 0

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
    /// Triggers the hover action: widen animation on hover-in, unwiden on hover-out.
    func updateHoverState(_ hovered: Bool) {
        guard hovered != isHovered else { return }
        isHovered = hovered

        if hovered {
            guard animationsActive else { isHovered = false; return }
            performWiden()
        } else {
            performUnwiden()
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
        currentBodyShape = bodyShape
        currentSize = size

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

        // Pre-compute morph paths for streaming animation.
        // Mirrors the eye blink approach: same EditablePath, same transform,
        // just control points perturbed — guarantees identical element count.
        morphPaths.removeAll()
        if bodyViewBox.width > 0 && bodyViewBox.height > 0 {
            let wobbleAmount: CGFloat = 0.12  // ±12% radial scale
            for seed in 0..<16 {
                let wobbled = seed == 0 ? bodyEditable : bodyEditable.wobbled(seed: seed, amount: wobbleAmount)
                let wCGPath = wobbled.toCGPath()
                var wTransform = bodyTransform
                if let transformed = wCGPath.copy(using: &wTransform) {
                    morphPaths.append(transformed)
                }
            }
        }

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

    // MARK: - Streaming (morph)

    func updateStreamingState(_ streaming: Bool) {
        guard streaming != isStreamingActive else { return }
        isStreamingActive = streaming
        if streaming {
            startMorph()
        } else {
            stopMorph()
        }
    }

    private func startMorph() {
        guard morphPaths.count >= 2 else { return }

        // Remove breathing — conflicts with morph.
        bodyLayer.removeAnimation(forKey: "breathing")
        morphTimer?.cancel()
        morphFrameIndex = 0

        // Timer-driven path morphing: cycle through morph paths using
        // CABasicAnimation for smooth interpolation between each pair.
        // This approach is proven to work (same as eye blink transitions).
        morphTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 150_000_000) // 0.15s per frame
                guard !Task.isCancelled, let self = self else { return }
                await MainActor.run {
                    guard self.isStreamingActive, self.morphPaths.count >= 2 else { return }
                    let fromIndex = self.morphFrameIndex
                    let toIndex = (fromIndex + 1) % self.morphPaths.count
                    self.morphFrameIndex = toIndex

                    let anim = CABasicAnimation(keyPath: "path")
                    anim.fromValue = self.morphPaths[fromIndex]
                    anim.toValue = self.morphPaths[toIndex]
                    anim.duration = 0.3
                    anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    anim.fillMode = .forwards
                    anim.isRemovedOnCompletion = false
                    self.bodyLayer.add(anim, forKey: "morph")
                    self.bodyLayer.path = self.morphPaths[toIndex]
                }
            }
        }

        // Transform morph layered on top for squash/stretch/rotation.
        let scaleX = CAKeyframeAnimation(keyPath: "transform.scale.x")
        scaleX.values = [1.0, 1.04, 0.97, 1.02, 1.0]
        scaleX.keyTimes = [0, 0.25, 0.5, 0.75, 1.0] as [NSNumber]
        scaleX.duration = 1.8
        scaleX.repeatCount = .infinity
        scaleX.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 4)

        let scaleY = CAKeyframeAnimation(keyPath: "transform.scale.y")
        scaleY.values = [1.0, 0.97, 1.04, 0.98, 1.0]
        scaleY.keyTimes = [0, 0.25, 0.5, 0.75, 1.0] as [NSNumber]
        scaleY.duration = 1.8
        scaleY.repeatCount = .infinity
        scaleY.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 4)

        let rotation = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        rotation.values = [0, 0.03, -0.03, 0.015, 0]
        rotation.keyTimes = [0, 0.25, 0.5, 0.75, 1.0] as [NSNumber]
        rotation.duration = 2.4
        rotation.repeatCount = .infinity
        rotation.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 4)

        bodyLayer.add(scaleX, forKey: "morph.scaleX")
        bodyLayer.add(scaleY, forKey: "morph.scaleY")
        bodyLayer.add(rotation, forKey: "morph.rotation")
    }

    private func stopMorph() {
        morphTimer?.cancel()
        morphTimer = nil
        bodyLayer.removeAnimation(forKey: "morph")
        bodyLayer.removeAnimation(forKey: "morph.scaleX")
        bodyLayer.removeAnimation(forKey: "morph.scaleY")
        bodyLayer.removeAnimation(forKey: "morph.rotation")
        // Restore original path (index 0 is the unmodified shape)
        if let original = morphPaths.first {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            bodyLayer.path = original
            CATransaction.commit()
        }
        if configBreathingEnabled {
            startBreathing()
        }
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
                self?.performEntry()
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

        // If the entry animation played but the post-entry delay was cancelled
        // before breathing/blink/twitch could start (e.g. window lost focus during
        // the 1.1s post-entry delay), start them fresh now instead of trying to
        // resume a non-existent breathing animation.
        if hasPlayedEntry && !postEntryAnimationsStarted {
            postEntryAnimationsStarted = true
            if configBreathingEnabled {
                bodyLayer.speed = 1
                bodyLayer.timeOffset = 0
                bodyLayer.beginTime = 0
                startBreathing()
            }
            return
        }

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

        // Play the character poke sound immediately on click, before starting the
        // poke animation. NSSound.play() is non-blocking so it won't delay the
        // animation start — both fire in the same run-loop tick.
        SoundManager.shared.play(.characterPoke)

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

    private func performEntry() {
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
            eyeLayer.add(anim, forKey: "reveal")
        }

        // --- Start other animations after a comfortable pause post-entry ---
        let postEntryDelay: TimeInterval = 1.1  // Entry (0.6s) + breathing pause (0.5s)
        postEntryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(postEntryDelay))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.animationsActive else { return }
                self.postEntryAnimationsStarted = true
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

    private func performWiden() {
        guard !eyeLayers.isEmpty,
              eyeLayers.count == widenedEyePaths.count else { return }

        for (i, eyeLayer) in eyeLayers.enumerated() {
            let animation = CABasicAnimation(keyPath: "path")
            animation.fromValue = eyeLayer.path
            animation.toValue = widenedEyePaths[i]
            animation.duration = 0.12
            animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
            eyeLayer.path = widenedEyePaths[i]
            eyeLayer.add(animation, forKey: "widen")
        }
    }

    private func performUnwiden() {
        guard !eyeLayers.isEmpty,
              eyeLayers.count == openEyePaths.count else { return }

        for (i, eyeLayer) in eyeLayers.enumerated() {
            let animation = CABasicAnimation(keyPath: "path")
            animation.fromValue = eyeLayer.path
            animation.toValue = openEyePaths[i]
            animation.duration = 0.2
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            eyeLayer.path = openEyePaths[i]
            eyeLayer.add(animation, forKey: "widen")
        }
    }
}
