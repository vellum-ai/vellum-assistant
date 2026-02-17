import SwiftUI
import VellumAssistantShared

struct ConstellationView: View {
    let identity: IdentityInfo?
    let skills: [SkillInfo]
    let workspaceFiles: [WorkspaceFileNode]

    @State private var nodesVisible = false

    private var existingFiles: [WorkspaceFileNode] {
        workspaceFiles.filter { $0.exists }
    }

    /// All items merged into one orbit ring.
    private var allItems: [OrbitItem] {
        let fileItems = existingFiles.map { node in
            OrbitItem(label: node.label, icon: "doc.text.fill", emoji: nil, color: Amber._400)
        }
        let skillItems = skills.map { skill in
            OrbitItem(label: skill.name, icon: "wand.and.stars", emoji: skill.emoji, color: Violet._400)
        }
        return fileItems + skillItems
    }

    var body: some View {
        GeometryReader { geometry in
            let center = CGPoint(x: geometry.size.width / 2, y: geometry.size.height / 2)
            let orbitRadius = min(geometry.size.width, geometry.size.height) * 0.38

            ZStack {
                // Background glow
                RadialGradient(
                    colors: [Violet._600.opacity(0.06), Color.clear],
                    center: .center,
                    startRadius: 0,
                    endRadius: min(geometry.size.width, geometry.size.height) * 0.5
                )
                .ignoresSafeArea()

                // Orbiting pills
                ForEach(Array(allItems.enumerated()), id: \.offset) { index, item in
                    let pos = orbitPosition(
                        center: center,
                        radius: orbitRadius,
                        index: index,
                        total: allItems.count
                    )
                    ConstellationPill(label: item.label, icon: item.icon, emoji: item.emoji, color: item.color)
                        .position(pos)
                        .scaleEffect(nodesVisible ? 1 : 0.4)
                        .opacity(nodesVisible ? 1 : 0)
                        .animation(
                            .spring(response: 0.5, dampingFraction: 0.7)
                                .delay(0.15 + Double(index) * 0.06),
                            value: nodesVisible
                        )
                }

                // Center dino face
                DinoFaceView(seed: identity?.name ?? "default")
                    .frame(width: 100, height: 100)
                    .position(center)
                    .scaleEffect(nodesVisible ? 1 : 0.6)
                    .opacity(nodesVisible ? 1 : 0)
                    .animation(.spring(response: 0.5, dampingFraction: 0.7).delay(0.05), value: nodesVisible)
            }
        }
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                nodesVisible = true
            }
        }
    }

    // MARK: - Orbit Layout

    /// Places items evenly around a circle, starting from the top.
    private func orbitPosition(center: CGPoint, radius: CGFloat, index: Int, total: Int) -> CGPoint {
        guard total > 0 else { return center }
        let angle = (2 * .pi * Double(index) / Double(total)) - .pi / 2 // start at top
        return CGPoint(
            x: center.x + radius * CGFloat(Darwin.cos(angle)),
            y: center.y + radius * CGFloat(Darwin.sin(angle))
        )
    }
}

// MARK: - Orbit Item

private struct OrbitItem {
    let label: String
    let icon: String
    let emoji: String?
    let color: Color
}

// MARK: - Polished Pill

private struct ConstellationPill: View {
    let label: String
    let icon: String
    let emoji: String?
    let color: Color

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            // Icon: show emoji if available, otherwise SF Symbol
            if let emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 13))
                    .frame(width: 24, height: 24)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(color.opacity(0.12))
                    )
            } else {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(color)
                    .frame(width: 24, height: 24)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .fill(color.opacity(0.12))
                    )
            }

            Text(label)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface.opacity(isHovered ? 1 : 0.9))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(
                            isHovered ? color.opacity(0.4) : VColor.surfaceBorder.opacity(0.6),
                            lineWidth: 1
                        )
                )
                .shadow(color: Color.black.opacity(isHovered ? 0.3 : 0.15), radius: isHovered ? 8 : 4, y: 2)
        )
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
    }
}
