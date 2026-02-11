import SwiftUI

/// The golden egg with glow, wobble animations, and crack overlays.
struct EggView: View {
    let stage: HatchStage
    let crackLevel: Int
    let onTap: () -> Void

    // Animation states
    @State private var floatOffset: CGFloat = 0
    @State private var wobbleAngle: Double = 0
    @State private var glowPulse: CGFloat = 1.0
    @State private var crackPulseScale: CGFloat = 1.0

    private var isIdle: Bool { stage == .idle }
    private var isCrack: Bool { stage == .crack }

    private var glowIntensity: CGFloat {
        if isCrack { return 60 }
        if crackLevel >= 2 { return 40 }
        if crackLevel >= 1 { return 25 }
        return 15
    }

    private var glowOpacity: Double {
        if isCrack || crackLevel >= 2 { return 0.8 }
        return 0.4
    }

    var body: some View {
        ZStack {
            // Glow
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: [
                            Amber._500.opacity(glowOpacity),
                            Color.clear
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: 210 + glowIntensity / 2
                    )
                )
                .frame(width: 420 + glowIntensity, height: 480 + glowIntensity)
                .scaleEffect(isIdle ? glowPulse : 1.0)
                .opacity(isIdle ? (glowPulse > 1.0 ? 0.7 : 0.4) : 1.0)

            // Egg body (programmatic golden egg shape)
            EggShape()
                .fill(
                    LinearGradient(
                        colors: [
                            Amber._300,
                            Amber._400,
                            Amber._500,
                            Amber._600
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                )
                .overlay(
                    EggShape()
                        .stroke(Amber._600, lineWidth: 2)
                )
                .frame(width: 200, height: 260)
                .shadow(color: Amber._500.opacity(0.5), radius: 20)

            // Crack overlays
            CrackOverlay(crackLevel: crackLevel)
                .frame(width: 200, height: 260)
        }
        .rotationEffect(.degrees(wobbleAngle))
        .offset(y: isIdle ? floatOffset : 0)
        .scaleEffect(isCrack ? crackPulseScale : 1.0)
        .onTapGesture { onTap() }
        .onAppear { startIdleAnimations() }
        .onChange(of: stage) { _, newStage in
            updateAnimations(for: newStage)
        }
        .onChange(of: crackLevel) { _, newLevel in
            if stage == .wobble {
                updateWobble(for: newLevel)
            }
        }
    }

    // MARK: - Animations

    private func startIdleAnimations() {
        // Float
        withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
            floatOffset = -12
        }
        // Glow pulse
        withAnimation(.easeInOut(duration: 2.5).repeatForever(autoreverses: true)) {
            glowPulse = 1.1
        }
    }

    private func updateAnimations(for newStage: HatchStage) {
        switch newStage {
        case .idle:
            startIdleAnimations()
        case .wobble:
            // Stop float
            withAnimation(.linear(duration: 0.2)) { floatOffset = 0 }
            updateWobble(for: crackLevel)
        case .crack:
            // Pulsing scale
            withAnimation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true)) {
                crackPulseScale = 1.05
            }
            // Stop wobble
            withAnimation(.easeInOut(duration: 0.3)) { wobbleAngle = 0 }
        case .burst, .reveal:
            break
        }
    }

    private func updateWobble(for level: Int) {
        let intensity: Double
        let duration: Double
        switch level {
        case 0:
            intensity = 3; duration = 0.6
        case 1:
            intensity = 6; duration = 0.4
        default:
            intensity = 12; duration = 0.3
        }
        withAnimation(.easeInOut(duration: duration).repeatForever(autoreverses: true)) {
            wobbleAngle = intensity
        }
        // Alternate direction
        DispatchQueue.main.asyncAfter(deadline: .now() + duration / 2) {
            withAnimation(.easeInOut(duration: duration).repeatForever(autoreverses: true)) {
                wobbleAngle = -intensity
            }
        }
    }
}

// MARK: - Egg Shape

struct EggShape: Shape {
    func path(in rect: CGRect) -> Path {
        // Classic egg: narrower at top, wider at bottom-center
        let w = rect.width
        let h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: w * 0.5, y: 0))
        path.addCurve(
            to: CGPoint(x: w, y: h * 0.55),
            control1: CGPoint(x: w * 0.85, y: 0),
            control2: CGPoint(x: w, y: h * 0.25)
        )
        path.addCurve(
            to: CGPoint(x: w * 0.5, y: h),
            control1: CGPoint(x: w, y: h * 0.82),
            control2: CGPoint(x: w * 0.75, y: h)
        )
        path.addCurve(
            to: CGPoint(x: 0, y: h * 0.55),
            control1: CGPoint(x: w * 0.25, y: h),
            control2: CGPoint(x: 0, y: h * 0.82)
        )
        path.addCurve(
            to: CGPoint(x: w * 0.5, y: 0),
            control1: CGPoint(x: 0, y: h * 0.25),
            control2: CGPoint(x: w * 0.15, y: 0)
        )
        return path
    }
}

// MARK: - Crack Overlay

struct CrackOverlay: View {
    let crackLevel: Int

    var body: some View {
        Canvas { context, size in
            let scaleX = size.width / 140
            let scaleY = size.height / 180

            func scaled(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: x * scaleX, y: y * scaleY)
            }

            let crackColor = Amber._200
            let crackColor2 = Amber._500

            // Crack level 1
            if crackLevel >= 1 {
                var p1 = Path()
                p1.move(to: scaled(65, 45))
                p1.addLine(to: scaled(60, 60))
                p1.addLine(to: scaled(68, 70))
                p1.addLine(to: scaled(62, 80))
                context.stroke(p1, with: .color(crackColor), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            }

            // Crack level 2
            if crackLevel >= 2 {
                var p2 = Path()
                p2.move(to: scaled(78, 50))
                p2.addLine(to: scaled(82, 65))
                p2.addLine(to: scaled(75, 75))
                p2.addLine(to: scaled(80, 85))
                context.stroke(p2, with: .color(crackColor), style: StrokeStyle(lineWidth: 2, lineCap: .round))

                var p3 = Path()
                p3.move(to: scaled(55, 70))
                p3.addLine(to: scaled(50, 80))
                p3.addLine(to: scaled(58, 88))
                context.stroke(p3, with: .color(crackColor2), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))

                // Glow ellipse
                let glowRect = CGRect(
                    x: (68 - 8) * scaleX, y: (72 - 6) * scaleY,
                    width: 16 * scaleX, height: 12 * scaleY
                )
                context.opacity = 0.6
                context.fill(Ellipse().path(in: glowRect), with: .color(crackColor.opacity(0.6)))
                context.opacity = 1.0
            }

            // Crack level 3
            if crackLevel >= 3 {
                var p4 = Path()
                p4.move(to: scaled(45, 55))
                p4.addLine(to: scaled(50, 70))
                p4.addLine(to: scaled(42, 82))
                p4.addLine(to: scaled(48, 95))
                context.stroke(p4, with: .color(crackColor), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

                var p5 = Path()
                p5.move(to: scaled(90, 60))
                p5.addLine(to: scaled(85, 75))
                p5.addLine(to: scaled(92, 85))
                context.stroke(p5, with: .color(crackColor), style: StrokeStyle(lineWidth: 2, lineCap: .round))

                var p6 = Path()
                p6.move(to: scaled(60, 85))
                p6.addLine(to: scaled(70, 90))
                p6.addLine(to: scaled(65, 100))
                context.stroke(p6, with: .color(crackColor2), style: StrokeStyle(lineWidth: 2, lineCap: .round))

                // Large glow
                let glow1 = CGRect(
                    x: (65 - 12) * scaleX, y: (70 - 10) * scaleY,
                    width: 24 * scaleX, height: 20 * scaleY
                )
                context.opacity = 0.8
                context.fill(Ellipse().path(in: glow1), with: .color(crackColor.opacity(0.8)))

                let glow2 = CGRect(
                    x: (80 - 8) * scaleX, y: (80 - 6) * scaleY,
                    width: 16 * scaleX, height: 12 * scaleY
                )
                context.opacity = 0.6
                context.fill(Ellipse().path(in: glow2), with: .color(crackColor.opacity(0.6)))
                context.opacity = 1.0
            }
        }
        .allowsHitTesting(false)
    }
}
