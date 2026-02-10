import SwiftUI

struct SoulOrbView: View {
    var mood: OrbMood
    var size: CGFloat = 56

    @State private var scale: CGFloat = 1.0
    @State private var ringScale: CGFloat = 1.0
    @State private var ringOpacity: Double = 0.0
    @State private var celebrateRings: [CGFloat] = [1.0, 1.0, 1.0]
    @State private var celebrateOpacities: [Double] = [0.6, 0.5, 0.4]

    var body: some View {
        ZStack {
            // Celebrate ring bursts
            if mood == .celebrating {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .stroke(Color(hex: 0xD4A843).opacity(celebrateOpacities[i]), lineWidth: 2)
                        .frame(width: size, height: size)
                        .scaleEffect(celebrateRings[i])
                }
            }

            // Listening pulse ring
            if mood == .listening {
                Circle()
                    .stroke(Color(hex: 0xD4A843).opacity(ringOpacity), lineWidth: 1.5)
                    .frame(width: size, height: size)
                    .scaleEffect(ringScale)
            }

            // Core orb
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [
                            Color(hex: 0xD4A843),
                            Color(hex: 0xB8922E),
                            Color(hex: 0x8B6914),
                        ]),
                        center: .center,
                        startRadius: 0,
                        endRadius: size / 2
                    )
                )
                .frame(width: size, height: size)
                .shadow(color: Color(hex: 0xD4A843).opacity(shadowOpacity), radius: shadowRadius)
                .scaleEffect(scale)
        }
        .onChange(of: mood, initial: true) { _, newMood in
            applyAnimation(for: newMood)
        }
    }

    private var shadowOpacity: Double {
        switch mood {
        case .egg: return 0.1
        case .dormant: return 0.2
        default: return 0.4
        }
    }

    private var shadowRadius: CGFloat {
        switch mood {
        case .egg: return 4
        case .dormant: return 6
        default: return 12
        }
    }

    private func applyAnimation(for mood: OrbMood) {
        switch mood {
        case .egg:
            withAnimation(.easeInOut(duration: 4.0).repeatForever(autoreverses: true)) {
                scale = 1.01
            }
        case .dormant:
            withAnimation(.easeInOut(duration: 3.5).repeatForever(autoreverses: true)) {
                scale = 1.02
            }
        case .breathing:
            withAnimation(.easeInOut(duration: 2).repeatForever(autoreverses: true)) {
                scale = 1.05
            }
        case .listening:
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                scale = 1.1
            }
            withAnimation(.easeOut(duration: 1.5).repeatForever(autoreverses: false)) {
                ringScale = 1.8
                ringOpacity = 0.0
            }
            // Reset ring for repeating pulse
            ringScale = 1.0
            ringOpacity = 0.5
            withAnimation(.easeOut(duration: 1.5).repeatForever(autoreverses: false)) {
                ringScale = 1.8
                ringOpacity = 0.0
            }
        case .celebrating:
            withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) {
                scale = 1.15
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                withAnimation(.spring(response: 0.4, dampingFraction: 0.6)) {
                    scale = 1.0
                }
            }
            // Ring bursts
            for i in 0..<3 {
                let delay = Double(i) * 0.15
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    celebrateRings[i] = 1.0
                    celebrateOpacities[i] = 0.6 - Double(i) * 0.1
                    withAnimation(.easeOut(duration: 0.8)) {
                        celebrateRings[i] = 2.5 + CGFloat(i) * 0.3
                        celebrateOpacities[i] = 0.0
                    }
                }
            }
        }
    }
}

extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

#Preview("Breathing") {
    ZStack {
        Color(hex: 0x0E0E11)
        SoulOrbView(mood: .breathing)
    }
    .frame(width: 200, height: 200)
}

#Preview("Listening") {
    ZStack {
        Color(hex: 0x0E0E11)
        SoulOrbView(mood: .listening)
    }
    .frame(width: 200, height: 200)
}

#Preview("Celebrating") {
    ZStack {
        Color(hex: 0x0E0E11)
        SoulOrbView(mood: .celebrating)
    }
    .frame(width: 200, height: 200)
}
