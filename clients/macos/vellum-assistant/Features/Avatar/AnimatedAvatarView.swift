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

    var body: some View {
        AvatarLayerRepresentable(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct AvatarLayerRepresentable: NSViewRepresentable {
    let bodyShape: AvatarBodyShape
    let eyeStyle: AvatarEyeStyle
    let color: AvatarColor
    let size: CGFloat

    func makeNSView(context: Context) -> AvatarLayerView {
        let view = AvatarLayerView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size)
        return view
    }

    func updateNSView(_ nsView: AvatarLayerView, context: Context) {
        nsView.configure(bodyShape: bodyShape, eyeStyle: eyeStyle, color: color, size: size)
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

    /// Timer that fires random blinks.
    private var blinkTask: Task<Void, Never>?

    /// Whether blinks are currently enabled (paused when window is inactive).
    private var blinkEnabled = true

    /// Notification observers for window key/resign-key events.
    private var notificationObservers: [NSObjectProtocol] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.addSublayer(bodyLayer)
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        blinkTask?.cancel()
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func configure(bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor, size: CGFloat) {
        let key = "\(bodyShape.rawValue)-\(eyeStyle.rawValue)-\(color.rawValue)-\(String(format: "%.1f", size))"
        guard key != currentKey else { return }
        currentKey = key

        // Update frame
        frame = NSRect(x: 0, y: 0, width: size, height: size)

        // Disable implicit CALayer animations during configuration
        CATransaction.begin()
        CATransaction.setDisableActions(true)

        // --- Body layer ---
        let bodyTransform = AvatarTransforms.bodyTransform(viewBox: bodyShape.viewBox, outputSize: size)
        let bodyEditable = parseSVGPathToEditable(bodyShape.svgPath)
        let bodyCGPath = bodyEditable.toCGPath()

        var mutableTransform = bodyTransform
        bodyLayer.path = bodyCGPath.copy(using: &mutableTransform)
        bodyLayer.fillColor = color.nsColor.cgColor
        bodyLayer.frame = CGRect(x: 0, y: 0, width: size, height: size)

        // Anchor scale from the center of the body layer so breathing animates symmetrically
        bodyLayer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        bodyLayer.position = CGPoint(x: frame.width / 2, y: frame.height / 2)

        // --- Eye layers ---
        // Remove old eye layers
        for layer in eyeLayers { layer.removeFromSuperlayer() }
        eyeLayers.removeAll()

        let faceCenter = AvatarTransforms.resolveFaceCenter(bodyShape: bodyShape, eyeStyle: eyeStyle)
        let eyeXform = AvatarTransforms.eyeTransform(
            eyeSourceViewBox: eyeStyle.sourceViewBox,
            eyeCenter: eyeStyle.eyeCenter,
            bodyViewBox: bodyShape.viewBox,
            faceCenter: faceCenter,
            bodyTransform: bodyTransform
        )

        // Pre-compute blink paths
        openEyePaths.removeAll()
        closedEyePaths.removeAll()

        for eyePath in eyeStyle.paths {
            let eyeEditable = parseSVGPathToEditable(eyePath.svgPath)
            let eyeCGPath = eyeEditable.toCGPath()
            var mutableEyeTransform = eyeXform
            let transformedEyePath = eyeCGPath.copy(using: &mutableEyeTransform)!

            let eyeLayer = CAShapeLayer()
            eyeLayer.path = transformedEyePath
            eyeLayer.fillColor = eyePath.color.cgColor
            eyeLayer.frame = CGRect(x: 0, y: 0, width: size, height: size)
            layer?.addSublayer(eyeLayer)
            eyeLayers.append(eyeLayer)

            // Store the open path (reuse the already-computed transformedEyePath)
            openEyePaths.append(transformedEyePath)

            // Closed path — squish Y toward center, then apply same transform
            let closedEditable = eyeEditable.blinked(amount: 1.0)
            let closedCGPath = closedEditable.toCGPath()
            var closedTransform = eyeXform
            closedEyePaths.append(closedCGPath.copy(using: &closedTransform)!)
        }

        CATransaction.commit()

        if blinkEnabled {
            startBlinkTimer()
            startBreathing()
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
                    guard let self, self.blinkEnabled else { return }
                    self.performBlink()
                }
            }
        }
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
        blinkEnabled = false
        blinkTask?.cancel()
        let pausedTime = bodyLayer.convertTime(CACurrentMediaTime(), from: nil)
        bodyLayer.speed = 0
        bodyLayer.timeOffset = pausedTime
    }

    private func resumeAnimations() {
        blinkEnabled = true
        startBlinkTimer()
        let pausedTime = bodyLayer.timeOffset
        bodyLayer.speed = 1
        bodyLayer.timeOffset = 0
        bodyLayer.beginTime = 0
        let timeSincePause = bodyLayer.convertTime(CACurrentMediaTime(), from: nil) - pausedTime
        bodyLayer.beginTime = timeSincePause
    }

    private func performBlink() {
        guard !eyeLayers.isEmpty,
              eyeLayers.count == openEyePaths.count,
              eyeLayers.count == closedEyePaths.count else { return }

        // ~20% chance of a double blink
        let isDoubleBlink = Double.random(in: 0...1) < 0.2

        for (i, eyeLayer) in eyeLayers.enumerated() {
            let animation: CAKeyframeAnimation
            if isDoubleBlink {
                animation = CAKeyframeAnimation(keyPath: "path")
                animation.values = [
                    openEyePaths[i],    // Start open
                    closedEyePaths[i],  // First close
                    openEyePaths[i],    // First open
                    closedEyePaths[i],  // Second close
                    openEyePaths[i],    // Final open
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
                animation.values = [openEyePaths[i], closedEyePaths[i], openEyePaths[i]]
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
