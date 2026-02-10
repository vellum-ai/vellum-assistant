import SwiftUI

// MARK: - Fireflies

struct Fireflies: View {
    let visible: Bool

    private let fireflies: [(x: CGFloat, y: CGFloat, dx: CGFloat, dy: CGFloat, dur: Double)] = [
        (0.20, 0.30, 30, -20, 6),
        (0.75, 0.25, -25, -30, 7),
        (0.40, 0.50, 20, -35, 5),
        (0.60, 0.40, 30, -20, 8),
        (0.85, 0.55, -25, -30, 6),
    ]

    var body: some View {
        if visible {
            GeometryReader { geo in
                ForEach(0..<fireflies.count, id: \.self) { i in
                    FireflyDot(
                        config: fireflies[i],
                        parentSize: geo.size,
                        delay: Double(i) * 0.5
                    )
                }
            }
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }
}

private struct FireflyDot: View {
    let config: (x: CGFloat, y: CGFloat, dx: CGFloat, dy: CGFloat, dur: Double)
    let parentSize: CGSize
    let delay: Double

    @State private var offset: CGSize = .zero
    @State private var opacity: Double = 0.2

    var body: some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [Color(red: 1, green: 0.835, blue: 0.31), .clear],
                    center: .center, startRadius: 0, endRadius: 4
                )
            )
            .frame(width: 8, height: 8)
            .shadow(color: Color(red: 1, green: 0.835, blue: 0.31).opacity(0.4), radius: 3)
            .opacity(opacity)
            .offset(offset)
            .position(x: config.x * parentSize.width, y: config.y * parentSize.height)
            .onAppear {
                withAnimation(.easeInOut(duration: config.dur).repeatForever(autoreverses: true).delay(delay)) {
                    offset = CGSize(width: config.dx, height: config.dy)
                    opacity = 0.8
                }
            }
    }
}

// MARK: - Petals

struct Petals: View {
    let visible: Bool

    var body: some View {
        if visible {
            GeometryReader { geo in
                ForEach(0..<5, id: \.self) { i in
                    PetalParticle(index: i, parentSize: geo.size)
                }
            }
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }
}

private struct PetalParticle: View {
    let index: Int
    let parentSize: CGSize

    @State private var yOffset: CGFloat = -20
    @State private var xOffset: CGFloat = 0
    @State private var rotation: Double = 0
    @State private var opacity: Double = 0

    private var color: Color {
        index % 2 == 0
            ? Color(red: 0.973, green: 0.733, blue: 0.816) // #f8bbd0
            : Color(red: 0.957, green: 0.561, blue: 0.694) // #f48fb1
    }

    var body: some View {
        Circle()
            .fill(RadialGradient(colors: [color, .clear], center: .center, startRadius: 0, endRadius: 6))
            .frame(width: 12, height: 12)
            .opacity(opacity)
            .rotationEffect(.degrees(rotation))
            .offset(x: xOffset, y: yOffset)
            .position(x: CGFloat(15 + index * 17) / 100 * parentSize.width, y: 0)
            .onAppear {
                let dur = 6.0 + Double(index) * 1.5
                let delay = Double(index) * 1.2
                withAnimation(.easeInOut(duration: dur).repeatForever(autoreverses: false).delay(delay)) {
                    yOffset = parentSize.height + 20
                    xOffset = 60
                    rotation = 360
                    opacity = 0.7
                }
            }
    }
}

// MARK: - Shell Pieces

struct ShellPieces: View {
    let visible: Bool

    private let pieces: [(x: CGFloat, y: CGFloat, rotate: Double)] = [
        (-120, -180, -200),
        (130, -160, 180),
        (-160, -60, -150),
        (170, -40, 220),
        (-80, -200, -260),
        (90, -190, 240),
    ]

    private let colors: [Color] = [
        Color(red: 0.91, green: 0.78, blue: 0.48),
        Color(red: 0.83, green: 0.66, blue: 0.33),
        Color(red: 0.77, green: 0.60, blue: 0.24),
        Color(red: 0.91, green: 0.78, blue: 0.48),
        Color(red: 0.83, green: 0.66, blue: 0.33),
        Color(red: 0.77, green: 0.60, blue: 0.24),
    ]

    var body: some View {
        if visible {
            ForEach(0..<pieces.count, id: \.self) { i in
                ShellPiece(
                    target: pieces[i],
                    color: colors[i],
                    shapeVariant: i % 3,
                    delay: Double(i) * 0.05
                )
            }
        }
    }
}

private struct ShellPiece: View {
    let target: (x: CGFloat, y: CGFloat, rotate: Double)
    let color: Color
    let shapeVariant: Int
    let delay: Double

    @State private var offset: CGSize = .zero
    @State private var rotation: Double = 0
    @State private var opacity: Double = 1

    var body: some View {
        ShellShape(variant: shapeVariant)
            .fill(color)
            .overlay(ShellShape(variant: shapeVariant).stroke(Color(red: 0.77, green: 0.60, blue: 0.24), lineWidth: 0.5))
            .frame(width: 16, height: 16)
            .opacity(opacity)
            .rotationEffect(.degrees(rotation))
            .offset(offset)
            .onAppear {
                withAnimation(.easeOut(duration: 0.8).delay(delay)) {
                    offset = CGSize(width: target.x, height: target.y)
                    rotation = target.rotate
                    opacity = 0
                }
            }
    }
}

private struct ShellShape: Shape {
    let variant: Int
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        var path = Path()
        switch variant {
        case 0: // Triangle
            path.move(to: CGPoint(x: s * 0.125, y: s * 0.875))
            path.addLine(to: CGPoint(x: s * 0.5, y: s * 0.0625))
            path.addLine(to: CGPoint(x: s * 0.875, y: s * 0.875))
            path.closeSubpath()
        case 1: // Diamond
            path.move(to: CGPoint(x: s * 0.0625, y: s * 0.625))
            path.addLine(to: CGPoint(x: s * 0.5, y: s * 0.0625))
            path.addLine(to: CGPoint(x: s * 0.9375, y: s * 0.625))
            path.addLine(to: CGPoint(x: s * 0.5, y: s * 0.9375))
            path.closeSubpath()
        default: // Smaller triangle
            path.move(to: CGPoint(x: s * 0.1875, y: s * 0.75))
            path.addLine(to: CGPoint(x: s * 0.5, y: s * 0.125))
            path.addLine(to: CGPoint(x: s * 0.8125, y: s * 0.75))
            path.closeSubpath()
        }
        return path
    }
}

// MARK: - Energy Ring

struct EnergyRing: View {
    let visible: Bool

    @State private var scale: CGFloat = 0
    @State private var opacity: Double = 0.8

    var body: some View {
        if visible {
            Circle()
                .stroke(Color(red: 1, green: 0.92, blue: 0.23), lineWidth: 2) // yellow-300
                .frame(width: 80, height: 80)
                .scaleEffect(scale)
                .opacity(opacity)
                .onAppear {
                    withAnimation(.easeOut(duration: 1)) {
                        scale = 4
                        opacity = 0
                    }
                }
        }
    }
}

// MARK: - Burst Sparkles

struct BurstSparkles: View {
    let visible: Bool

    private let targets: [(x: CGFloat, y: CGFloat)] = [
        (-100, -140), (80, -160), (-140, -40), (150, -20),
        (-60, -180), (120, -100), (-130, -120), (40, -190),
    ]

    var body: some View {
        if visible {
            ForEach(0..<targets.count, id: \.self) { i in
                BurstSparkleParticle(target: targets[i], delay: Double(i) * 0.04)
            }
        }
    }
}

private struct BurstSparkleParticle: View {
    let target: (x: CGFloat, y: CGFloat)
    let delay: Double

    @State private var offset: CGSize = .zero
    @State private var scale: CGFloat = 1
    @State private var opacity: Double = 1

    var body: some View {
        SparkleShape()
            .fill(Color(red: 1, green: 0.835, blue: 0.31))
            .frame(width: 12, height: 12)
            .scaleEffect(scale)
            .opacity(opacity)
            .offset(offset)
            .onAppear {
                withAnimation(.easeOut(duration: 1).delay(delay)) {
                    offset = CGSize(width: target.x, height: target.y)
                    scale = 0
                    opacity = 0
                }
            }
    }
}

// MARK: - Reveal Sparkles

struct RevealSparkles: View {
    let visible: Bool

    private let positions: [(x: CGFloat, y: CGFloat)] = [
        (-40, -50), (40, -40), (-50, 10),
        (50, 0), (-20, -60), (30, -55),
    ]

    var body: some View {
        if visible {
            ForEach(0..<positions.count, id: \.self) { i in
                RevealSparkleParticle(pos: positions[i], index: i)
            }
        }
    }
}

private struct RevealSparkleParticle: View {
    let pos: (x: CGFloat, y: CGFloat)
    let index: Int

    @State private var scale: CGFloat = 0
    @State private var rotation: Double = 0
    @State private var opacity: Double = 1

    var body: some View {
        SparkleShape()
            .fill(Color(red: 1, green: 0.835, blue: 0.31))
            .frame(width: 10, height: 10)
            .scaleEffect(scale)
            .rotationEffect(.degrees(rotation))
            .opacity(opacity)
            .offset(x: pos.x, y: pos.y)
            .onAppear {
                let dur = 1.5 + Double(index) * 0.2
                let delay = 0.5 + Double(index) * 0.15
                withAnimation(.easeInOut(duration: dur).delay(delay)) {
                    scale = 1.2
                    rotation = 360
                    opacity = 0
                }
            }
    }
}

// MARK: - White Flash

struct WhiteFlash: View {
    let visible: Bool

    @State private var opacity: Double = 0

    var body: some View {
        if visible {
            Color.white
                .opacity(opacity)
                .allowsHitTesting(false)
                .onAppear {
                    withAnimation(.easeOut(duration: 0.3)) {
                        opacity = 0.85
                    }
                    withAnimation(.easeOut(duration: 0.6).delay(0.3)) {
                        opacity = 0
                    }
                }
        }
    }
}

// MARK: - Sparkle Shape (4-point star)

struct SparkleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: w * 0.5, y: 0))
        path.addLine(to: CGPoint(x: w * 0.583, y: h * 0.375))
        path.addLine(to: CGPoint(x: w, y: h * 0.5))
        path.addLine(to: CGPoint(x: w * 0.583, y: h * 0.625))
        path.addLine(to: CGPoint(x: w * 0.5, y: h))
        path.addLine(to: CGPoint(x: w * 0.417, y: h * 0.625))
        path.addLine(to: CGPoint(x: 0, y: h * 0.5))
        path.addLine(to: CGPoint(x: w * 0.417, y: h * 0.375))
        path.closeSubpath()
        return path
    }
}
