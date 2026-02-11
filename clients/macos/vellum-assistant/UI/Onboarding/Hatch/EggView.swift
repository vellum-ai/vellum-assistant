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
            // Glow — warm amber for dino egg
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 0.95, green: 0.78, blue: 0.35).opacity(glowOpacity),
                            Color(red: 0.85, green: 0.65, blue: 0.25).opacity(glowOpacity * 0.4),
                            Color.clear
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: 200 + glowIntensity / 2
                    )
                )
                .frame(width: 380 + glowIntensity, height: 480 + glowIntensity)
                .scaleEffect(isIdle ? glowPulse : 1.0)
                .opacity(isIdle ? (glowPulse > 1.0 ? 0.7 : 0.4) : 1.0)

            // Egg body
            ZStack {
                // Base fill — earthy radial gradient for leathery dino-egg look
                EggShape()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(red: 0.92, green: 0.88, blue: 0.78),
                                Color(red: 0.85, green: 0.79, blue: 0.66),
                                Color(red: 0.76, green: 0.68, blue: 0.52),
                                Color(red: 0.65, green: 0.56, blue: 0.40)
                            ],
                            center: UnitPoint(x: 0.42, y: 0.38),
                            startRadius: 10,
                            endRadius: 160
                        )
                    )

                // Edge darkening — deeper shadow for thick shell
                EggShape()
                    .stroke(
                        RadialGradient(
                            colors: [Color.clear, Color(red: 0.40, green: 0.32, blue: 0.18).opacity(0.45)],
                            center: UnitPoint(x: 0.42, y: 0.38),
                            startRadius: 50,
                            endRadius: 140
                        ),
                        lineWidth: 10
                    )
                    .clipShape(EggShape())

                // Bumpy texture overlay — drawn in Canvas for organic feel
                EggTexture()
                    .clipShape(EggShape())

                // Specular highlight — subtle matte sheen upper-left
                Ellipse()
                    .fill(
                        RadialGradient(
                            colors: [Color.white.opacity(0.28), Color.white.opacity(0.08), Color.clear],
                            center: .center,
                            startRadius: 0,
                            endRadius: 50
                        )
                    )
                    .frame(width: 80, height: 55)
                    .offset(x: -20, y: -55)
                    .clipShape(EggShape())

                // Secondary rim light — faint bottom-right
                Ellipse()
                    .fill(
                        RadialGradient(
                            colors: [Color.white.opacity(0.10), Color.clear],
                            center: .center,
                            startRadius: 0,
                            endRadius: 30
                        )
                    )
                    .frame(width: 45, height: 35)
                    .offset(x: 35, y: 65)
                    .clipShape(EggShape())

                // Speckles — irregular markings like a real dino egg
                EggSpeckles()
                    .clipShape(EggShape())

                // Shell outline — slightly rough
                EggShape()
                    .stroke(Color(red: 0.50, green: 0.42, blue: 0.28).opacity(0.4), lineWidth: 1.5)
            }
            .frame(width: 230, height: 310)
            .shadow(color: Color(red: 1, green: 0.835, blue: 0.31).opacity(0.35), radius: 18)

            // Crack overlays
            CrackOverlay(crackLevel: crackLevel)
                .frame(width: 230, height: 310)
        }
        .rotationEffect(.degrees(wobbleAngle))
        .offset(y: isIdle ? floatOffset : 0)
        .scaleEffect(isCrack ? crackPulseScale : 1.0)
        .onTapGesture { onTap() }
        .onAppear { updateAnimations(for: stage) }
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
        // Dinosaur egg: elongated, narrower top, wider lower belly
        let w = rect.width
        let h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: w * 0.5, y: 0))
        // Top-right curve (narrow, tapered)
        path.addCurve(
            to: CGPoint(x: w, y: h * 0.45),
            control1: CGPoint(x: w * 0.74, y: 0),
            control2: CGPoint(x: w, y: h * 0.18)
        )
        // Bottom-right curve (wide belly, lower center of mass)
        path.addCurve(
            to: CGPoint(x: w * 0.5, y: h),
            control1: CGPoint(x: w, y: h * 0.76),
            control2: CGPoint(x: w * 0.76, y: h)
        )
        // Bottom-left curve (wide belly)
        path.addCurve(
            to: CGPoint(x: 0, y: h * 0.45),
            control1: CGPoint(x: w * 0.24, y: h),
            control2: CGPoint(x: 0, y: h * 0.76)
        )
        // Top-left curve (narrow, tapered)
        path.addCurve(
            to: CGPoint(x: w * 0.5, y: 0),
            control1: CGPoint(x: 0, y: h * 0.18),
            control2: CGPoint(x: w * 0.26, y: 0)
        )
        return path
    }
}

// MARK: - Egg Texture (bumpy surface)

struct EggTexture: View {
    var body: some View {
        Canvas { context, size in
            // Seed-based deterministic bumps for leathery/pebbly texture
            let bumps: [(x: CGFloat, y: CGFloat, r: CGFloat, op: CGFloat)] = [
                // Lighter bumps (raised areas catching light)
                (0.30, 0.22, 18, 0.06), (0.55, 0.18, 14, 0.05),
                (0.70, 0.30, 16, 0.06), (0.25, 0.42, 20, 0.07),
                (0.60, 0.40, 15, 0.05), (0.40, 0.55, 18, 0.06),
                (0.75, 0.52, 14, 0.05), (0.35, 0.70, 16, 0.06),
                (0.58, 0.65, 19, 0.07), (0.45, 0.82, 15, 0.05),
                (0.68, 0.75, 17, 0.06), (0.28, 0.85, 13, 0.05),
                // Darker bumps (shadows between bumps)
                (0.38, 0.28, 10, 0.08), (0.62, 0.32, 9, 0.07),
                (0.48, 0.48, 11, 0.08), (0.32, 0.58, 10, 0.07),
                (0.65, 0.55, 12, 0.09), (0.50, 0.72, 10, 0.07),
                (0.40, 0.38, 8, 0.06), (0.72, 0.45, 9, 0.07),
            ]

            for (i, bump) in bumps.enumerated() {
                let cx = bump.x * size.width
                let cy = bump.y * size.height
                let rect = CGRect(x: cx - bump.r, y: cy - bump.r, width: bump.r * 2, height: bump.r * 2)
                let color: Color = i < 12
                    ? Color.white.opacity(bump.op)
                    : Color(red: 0.40, green: 0.32, blue: 0.18).opacity(bump.op)
                context.fill(Ellipse().path(in: rect), with: .color(color))
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Egg Speckles (irregular dino-egg markings)

struct EggSpeckles: View {
    // Irregular speckles — varied sizes, some elongated, earthy tones
    private let speckles: [(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, rot: Double, opacity: Double, dark: Bool)] = [
        // Dark speckles
        (0.32, 0.25, 8, 5, 25, 0.22, true),
        (0.60, 0.20, 6, 4, -15, 0.18, true),
        (0.22, 0.45, 10, 6, 40, 0.25, true),
        (0.72, 0.38, 7, 5, -30, 0.20, true),
        (0.45, 0.58, 9, 5, 10, 0.22, true),
        (0.55, 0.70, 6, 4, -20, 0.17, true),
        (0.30, 0.75, 8, 5, 35, 0.20, true),
        (0.68, 0.60, 7, 4, -10, 0.18, true),
        (0.50, 0.35, 5, 4, 15, 0.16, true),
        (0.38, 0.88, 7, 4, -25, 0.19, true),
        (0.75, 0.50, 6, 3, 20, 0.15, true),
        (0.42, 0.15, 5, 3, -5, 0.14, true),
        // Light speckles (mineral deposits)
        (0.48, 0.30, 4, 3, 30, 0.12, false),
        (0.65, 0.45, 5, 3, -35, 0.10, false),
        (0.35, 0.62, 4, 3, 15, 0.11, false),
        (0.58, 0.80, 5, 4, -20, 0.10, false),
    ]

    var body: some View {
        GeometryReader { geo in
            ForEach(0..<speckles.count, id: \.self) { i in
                let s = speckles[i]
                Ellipse()
                    .fill(
                        s.dark
                            ? Color(red: 0.38, green: 0.30, blue: 0.16).opacity(s.opacity)
                            : Color(red: 0.88, green: 0.84, blue: 0.72).opacity(s.opacity)
                    )
                    .frame(width: s.w, height: s.h)
                    .rotationEffect(.degrees(s.rot))
                    .position(
                        x: s.x * geo.size.width,
                        y: s.y * geo.size.height
                    )
            }
        }
        .allowsHitTesting(false)
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

            let crackColor = Color(red: 1, green: 0.976, blue: 0.769) // #fff9c4
            let crackColor2 = Color(red: 1, green: 0.835, blue: 0.31) // #ffd54f
            let glowColor = Color(red: 1, green: 0.95, blue: 0.7)

            // Crack level 1 — first sign of life
            if crackLevel >= 1 {
                // Main crack down the center-left
                var p1 = Path()
                p1.move(to: scaled(68, 35))
                p1.addLine(to: scaled(62, 50))
                p1.addLine(to: scaled(70, 62))
                p1.addLine(to: scaled(60, 78))
                p1.addLine(to: scaled(66, 90))
                context.stroke(p1, with: .color(crackColor), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                // Inner glow along crack
                context.stroke(p1, with: .color(glowColor.opacity(0.4)), style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))

                // Small branch
                var b1 = Path()
                b1.move(to: scaled(62, 50))
                b1.addLine(to: scaled(55, 58))
                context.stroke(b1, with: .color(crackColor2), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

                // Glow at crack origin
                let glow0 = CGRect(
                    x: (64 - 8) * scaleX, y: (60 - 8) * scaleY,
                    width: 16 * scaleX, height: 16 * scaleY
                )
                context.opacity = 0.5
                context.fill(Ellipse().path(in: glow0), with: .color(glowColor.opacity(0.5)))
                context.opacity = 1.0
            }

            // Crack level 2 — spreading
            if crackLevel >= 2 {
                // Right-side crack
                var p2 = Path()
                p2.move(to: scaled(80, 40))
                p2.addLine(to: scaled(85, 55))
                p2.addLine(to: scaled(76, 68))
                p2.addLine(to: scaled(83, 82))
                p2.addLine(to: scaled(78, 95))
                context.stroke(p2, with: .color(crackColor), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                context.stroke(p2, with: .color(glowColor.opacity(0.35)), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))

                // Branch from right crack
                var b2 = Path()
                b2.move(to: scaled(85, 55))
                b2.addLine(to: scaled(92, 48))
                context.stroke(b2, with: .color(crackColor2), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

                // Left branch
                var p3 = Path()
                p3.move(to: scaled(55, 58))
                p3.addLine(to: scaled(48, 72))
                p3.addLine(to: scaled(54, 85))
                context.stroke(p3, with: .color(crackColor2), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))

                // Glow where cracks meet
                let glowRect = CGRect(
                    x: (68 - 12) * scaleX, y: (68 - 10) * scaleY,
                    width: 24 * scaleX, height: 20 * scaleY
                )
                context.opacity = 0.7
                context.fill(Ellipse().path(in: glowRect), with: .color(glowColor.opacity(0.7)))
                context.opacity = 1.0
            }

            // Crack level 3 — about to burst
            if crackLevel >= 3 {
                // Far-left crack
                var p4 = Path()
                p4.move(to: scaled(42, 48))
                p4.addLine(to: scaled(48, 65))
                p4.addLine(to: scaled(38, 80))
                p4.addLine(to: scaled(45, 98))
                context.stroke(p4, with: .color(crackColor), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                context.stroke(p4, with: .color(glowColor.opacity(0.3)), style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))

                // Far-right crack
                var p5 = Path()
                p5.move(to: scaled(95, 52))
                p5.addLine(to: scaled(88, 70))
                p5.addLine(to: scaled(96, 88))
                context.stroke(p5, with: .color(crackColor), style: StrokeStyle(lineWidth: 3.5, lineCap: .round, lineJoin: .round))
                context.stroke(p5, with: .color(glowColor.opacity(0.3)), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))

                // Connecting crack across middle
                var p6 = Path()
                p6.move(to: scaled(55, 85))
                p6.addLine(to: scaled(65, 82))
                p6.addLine(to: scaled(78, 88))
                context.stroke(p6, with: .color(crackColor2), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))

                // Top crack
                var p7 = Path()
                p7.move(to: scaled(60, 30))
                p7.addLine(to: scaled(68, 35))
                p7.addLine(to: scaled(75, 30))
                context.stroke(p7, with: .color(crackColor), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))

                // Large central glow — light pouring through
                let glow1 = CGRect(
                    x: (65 - 18) * scaleX, y: (70 - 16) * scaleY,
                    width: 36 * scaleX, height: 32 * scaleY
                )
                context.opacity = 0.9
                context.fill(Ellipse().path(in: glow1), with: .color(glowColor.opacity(0.6)))

                // Secondary glow
                let glow2 = CGRect(
                    x: (82 - 10) * scaleX, y: (78 - 8) * scaleY,
                    width: 20 * scaleX, height: 16 * scaleY
                )
                context.opacity = 0.7
                context.fill(Ellipse().path(in: glow2), with: .color(glowColor.opacity(0.5)))
                context.opacity = 1.0
            }
        }
        .allowsHitTesting(false)
    }
}
