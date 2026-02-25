import SwiftUI
import VellumAssistantShared

// MARK: - Skill Category

private enum SkillCategory: String, CaseIterable {
    case core
    case devTools
    case communication
    case daily
    case utilities
    case skills // fallback

    var displayName: String {
        switch self {
        case .core: return "Core"
        case .devTools: return "Dev Tools"
        case .communication: return "Comms"
        case .daily: return "Daily"
        case .utilities: return "Utilities"
        case .skills: return "Skills"
        }
    }

    /// Category accent colors inspired by game skill trees.
    /// Core = gold, Dev Tools = red, Comms = purple, fallback = teal.
    var color: Color {
        switch self {
        case .core: return Color(hex: 0xE9C91A)
        case .devTools: return Color(hex: 0xC1421B)
        case .communication: return Color(hex: 0xAD88BC)
        case .daily: return Color(hex: 0x0E9B8B)
        case .utilities: return Color(hex: 0x0E9B8B)
        case .skills: return Color(hex: 0x0E9B8B)
        }
    }

    var icon: String {
        switch self {
        case .core: return "doc.text.fill"
        case .devTools: return "hammer.fill"
        case .communication: return "bubble.left.fill"
        case .daily: return "sun.max.fill"
        case .utilities: return "wrench.fill"
        case .skills: return "wand.and.stars"
        }
    }
}

// MARK: - Data Models

private struct OrbitItem: Identifiable {
    let id: String
    let label: String
    let icon: String
    let emoji: String?
    let color: Color
    let filePath: String?
}

private struct CategoryGroup: Identifiable {
    var id: String { category.rawValue }
    let category: SkillCategory
    var items: [OrbitItem]
}

// MARK: - Category Inference

private func inferCategory(_ skill: SkillInfo) -> SkillCategory {
    let text = (skill.name + " " + skill.description).lowercased()

    if text.contains("code") || text.contains("app builder") || text.contains("github")
        || text.contains("developer") || text.contains("programming") || text.contains("debug") {
        return .devTools
    }
    if text.contains("gmail") || text.contains("email") || text.contains("slack")
        || text.contains("message") || text.contains("chat") || text.contains("mail") {
        return .communication
    }
    if text.contains("weather") || text.contains("start the day") || text.contains("briefing")
        || text.contains("morning") || text.contains("daily") || text.contains("news") {
        return .daily
    }
    if text.contains("upgrade") || text.contains("summarize") || text.contains("convert")
        || text.contains("gog") || text.contains("utility") || text.contains("transform") {
        return .utilities
    }
    return .skills
}

// MARK: - Dot Grid Background

private struct DotGridBackground: View {
    let spacing: CGFloat = 20
    let dotRadius: CGFloat = 1

    var body: some View {
        Canvas { context, size in
            let cols = Int(size.width / spacing) + 1
            let rows = Int(size.height / spacing) + 1
            for row in 0..<rows {
                for col in 0..<cols {
                    let point = CGPoint(x: CGFloat(col) * spacing, y: CGFloat(row) * spacing)
                    let rect = CGRect(
                        x: point.x - dotRadius,
                        y: point.y - dotRadius,
                        width: dotRadius * 2,
                        height: dotRadius * 2
                    )
                    context.fill(Circle().path(in: rect), with: .color(Moss._500.opacity(0.4)))
                }
            }
        }
    }
}

// MARK: - Hexagon Shape

/// Pointy-top hexagon shape for the skill tree tiles.
private struct HexagonShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        let cx = rect.midX
        let cy = rect.midY
        // Pointy-top: vertices at 30-degree intervals starting from top
        // For a pointy-top hex inscribed in the rect:
        //   width = sqrt(3) * size, height = 2 * size
        let size = min(w / sqrt(3), h / 2)
        var path = Path()
        for i in 0..<6 {
            let angleDeg = 60.0 * Double(i) - 90.0
            let angleRad = angleDeg * .pi / 180.0
            let px = cx + size * CGFloat(cos(angleRad))
            let py = cy + size * CGFloat(sin(angleRad))
            if i == 0 {
                path.move(to: CGPoint(x: px, y: py))
            } else {
                path.addLine(to: CGPoint(x: px, y: py))
            }
        }
        path.closeSubpath()
        return path
    }
}

// MARK: - Hex Coordinate

/// Axial hex coordinate (q, r) for pointy-top hexagonal grid layout.
private struct HexCoord: Hashable {
    let q: Int
    let r: Int

    /// Convert axial coordinate to pixel position (pointy-top orientation).
    func toPixel(size: CGFloat, gap: CGFloat) -> CGPoint {
        let effectiveSize = size + gap / 2
        let x = effectiveSize * (sqrt(3) * CGFloat(q) + sqrt(3) / 2 * CGFloat(r))
        let y = effectiveSize * (3.0 / 2.0 * CGFloat(r))
        return CGPoint(x: x, y: y)
    }
}

/// Ring 1 positions (6 hexes immediately around center) for pointy-top hex grid.
private let ring1Coords: [HexCoord] = [
    HexCoord(q: 1, r: 0),
    HexCoord(q: 0, r: 1),
    HexCoord(q: -1, r: 1),
    HexCoord(q: -1, r: 0),
    HexCoord(q: 0, r: -1),
    HexCoord(q: 1, r: -1),
]

/// Returns the axial hex neighbors adjacent to a given hex, filtered to exclude
/// positions already in use and the center hex.
private func neighborsOf(_ coord: HexCoord, excluding used: Set<HexCoord>) -> [HexCoord] {
    let directions = [
        HexCoord(q: 1, r: 0), HexCoord(q: 0, r: 1), HexCoord(q: -1, r: 1),
        HexCoord(q: -1, r: 0), HexCoord(q: 0, r: -1), HexCoord(q: 1, r: -1),
    ]
    return directions.compactMap { dir in
        let neighbor = HexCoord(q: coord.q + dir.q, r: coord.r + dir.r)
        if used.contains(neighbor) || (neighbor.q == 0 && neighbor.r == 0) {
            return nil
        }
        return neighbor
    }
}

/// Computes the hex ring at a given distance from center.
private func hexRing(radius: Int) -> [HexCoord] {
    guard radius > 0 else { return [HexCoord(q: 0, r: 0)] }
    let directions = [
        HexCoord(q: 1, r: 0), HexCoord(q: 0, r: 1), HexCoord(q: -1, r: 1),
        HexCoord(q: -1, r: 0), HexCoord(q: 0, r: -1), HexCoord(q: 1, r: -1),
    ]
    var results: [HexCoord] = []
    // Start at the hex that is `radius` steps in direction 4 (q: 0, r: -1)
    var current = HexCoord(q: 0, r: -radius)
    for side in 0..<6 {
        for _ in 0..<radius {
            results.append(current)
            current = HexCoord(
                q: current.q + directions[side].q,
                r: current.r + directions[side].r
            )
        }
    }
    return results
}

// MARK: - Hex Tile View (Leaf)

private struct HexTileView: View {
    let label: String
    let icon: String
    let emoji: String?
    let color: Color
    let size: CGFloat
    var onTap: (() -> Void)?

    @State private var isHovered = false

    private var isTappable: Bool { onTap != nil }

    var body: some View {
        let hexWidth = sqrt(3) * size
        let hexHeight = 2 * size

        VStack(spacing: 2) {
            if let emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 16))
            } else {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(color)
            }

            Text(label)
                .font(VFont.small)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: hexWidth * 0.75)
        }
        .frame(width: hexWidth, height: hexHeight)
        .background(
            HexagonShape()
                .fill(color.opacity(isHovered ? 0.18 : 0.08))
        )
        .overlay(
            HexagonShape()
                .stroke(color.opacity(isHovered ? 0.7 : 0.35), lineWidth: isHovered ? 2 : 1.5)
        )
        .contentShape(HexagonShape())
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
            #if os(macOS)
            if isTappable {
                if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            #endif
        }
        #if os(macOS)
        .onDisappear {
            if isHovered && isTappable {
                NSCursor.pop()
                isHovered = false
            }
        }
        #endif
        .onTapGesture {
            onTap?()
        }
    }
}

// MARK: - Hub Hex Tile View

private struct HubHexTileView: View {
    let category: SkillCategory
    let size: CGFloat

    @State private var isHovered = false

    var body: some View {
        let hexWidth = sqrt(3) * size
        let hexHeight = 2 * size

        VStack(spacing: 3) {
            Image(systemName: category.icon)
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(category.color)

            Text(category.displayName)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
        }
        .padding(4)
        .frame(width: hexWidth, height: hexHeight)
        .background(
            HexagonShape()
                .fill(category.color.opacity(isHovered ? 0.26 : 0.16))
        )
        .overlay(
            HexagonShape()
                .stroke(category.color.opacity(isHovered ? 0.85 : 0.55), lineWidth: isHovered ? 3 : 2.5)
        )
        .contentShape(HexagonShape())
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
    }
}

// MARK: - Animation Phase

private enum AnimationPhase: Equatable {
    case hidden
    case complete

    var centerVisible: Bool { self == .complete }
    var hubsVisible: Bool { self == .complete }
    var leavesVisible: Bool { self == .complete }
}

// MARK: - Positioned Hex Item

/// Pairs a hex coordinate with its content metadata for rendering.
private struct PositionedHex: Identifiable {
    let id: String
    let coord: HexCoord
    let kind: HexKind
}

private enum HexKind {
    case hub(SkillCategory)
    case leaf(OrbitItem)
}

// MARK: - Constellation View

struct ConstellationView: View {
    let identity: IdentityInfo?
    let skills: [SkillInfo]
    let workspaceFiles: [WorkspaceFileNode]
    var onFileSelected: ((String) -> Void)?
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var phase: AnimationPhase = .hidden
    @State private var panOffset: CGSize = .zero
    @State private var dragOffset: CGSize = .zero
    @State private var zoomScale: CGFloat = 1.0
    @State private var baseZoomScale: CGFloat = 1.0

    // Uniform hex size for both positioning and rendering — hubs are
    // visually distinguished via styling (heavier border, higher fill
    // opacity, larger font) rather than a physically bigger hexagon.
    private let hexSize: CGFloat = 62
    private let hexGap: CGFloat = 4

    private var existingFiles: [WorkspaceFileNode] {
        workspaceFiles.filter { $0.exists }
    }

    private var groups: [CategoryGroup] {
        let fileItems = existingFiles.enumerated().map { idx, node in
            let path: String? = node.label.hasSuffix(".md") ? node.path : nil
            return OrbitItem(
                id: "core-\(idx)", label: node.label, icon: "doc.text.fill",
                emoji: nil, color: SkillCategory.core.color, filePath: path
            )
        }

        var categoryMap: [SkillCategory: [OrbitItem]] = [:]
        for skill in skills {
            let cat = inferCategory(skill)
            let idx = categoryMap[cat]?.count ?? 0
            let item = OrbitItem(
                id: "\(cat.rawValue)-\(idx)",
                label: skill.name,
                icon: cat.icon,
                emoji: skill.emoji,
                color: cat.color,
                filePath: nil
            )
            categoryMap[cat, default: []].append(item)
        }

        var result: [CategoryGroup] = []

        if !fileItems.isEmpty {
            result.append(CategoryGroup(category: .core, items: fileItems))
        }

        for cat in SkillCategory.allCases where cat != .core {
            if let items = categoryMap[cat], !items.isEmpty {
                result.append(CategoryGroup(category: cat, items: items))
            }
        }

        return result
    }

    /// Computes hex positions for all hubs and their leaves, fanning outward from center.
    private var positionedHexes: [PositionedHex] {
        let layoutGroups = groups
        var result: [PositionedHex] = []
        var usedCoords: Set<HexCoord> = [HexCoord(q: 0, r: 0)]

        // Place category hubs in ring 1
        let hubCount = min(layoutGroups.count, ring1Coords.count)
        var hubCoords: [HexCoord] = []

        for i in 0..<hubCount {
            let coord = ring1Coords[i]
            hubCoords.append(coord)
            usedCoords.insert(coord)
            result.append(PositionedHex(
                id: "hub-\(layoutGroups[i].category.rawValue)",
                coord: coord,
                kind: .hub(layoutGroups[i].category)
            ))
        }

        // Place leaf items in round-robin across categories so that no
        // single category starves later ones of free neighbor positions.
        // Each category maintains its own expansion frontier rooted at its hub.
        struct CategoryState {
            var leafQueue: [OrbitItem]
            let hubCoord: HexCoord
            var frontier: [HexCoord]
        }

        var states: [CategoryState] = (0..<hubCount).map { i in
            CategoryState(
                leafQueue: layoutGroups[i].items,
                hubCoord: hubCoords[i],
                frontier: [hubCoords[i]]
            )
        }

        var anyPlaced = true
        while anyPlaced {
            anyPlaced = false
            for idx in 0..<states.count {
                if states[idx].leafQueue.isEmpty { continue }

                // Expand frontier: find all unused neighbors of current frontier
                var candidateCoords: [HexCoord] = []
                for f in states[idx].frontier {
                    let neighbors = neighborsOf(f, excluding: usedCoords)
                    for n in neighbors where !candidateCoords.contains(where: { $0 == n }) {
                        candidateCoords.append(n)
                    }
                }

                // Sort candidates by distance from center to prefer outward expansion,
                // then by distance from hub to keep the group clustered
                let hub = states[idx].hubCoord
                candidateCoords.sort { a, b in
                    let distA = abs(a.q) + abs(a.r) + abs(a.q + a.r)
                    let distB = abs(b.q) + abs(b.r) + abs(b.q + b.r)
                    if distA != distB { return distA < distB }
                    let hubDistA = abs(a.q - hub.q) + abs(a.r - hub.r)
                    let hubDistB = abs(b.q - hub.q) + abs(b.r - hub.r)
                    return hubDistA < hubDistB
                }

                // Place one leaf per category per round
                if let coord = candidateCoords.first {
                    let item = states[idx].leafQueue.removeFirst()
                    usedCoords.insert(coord)
                    states[idx].frontier.append(coord)
                    result.append(PositionedHex(
                        id: item.id,
                        coord: coord,
                        kind: .leaf(item)
                    ))
                    anyPlaced = true
                }
            }
        }

        return result
    }

    var body: some View {
        GeometryReader { proxy in
            let totalOffset = CGSize(
                width: panOffset.width + dragOffset.width,
                height: panOffset.height + dragOffset.height
            )
            ZStack {
                DotGridBackground()

                canvas(size: proxy.size)
                    .scaleEffect(zoomScale)
                    .offset(totalOffset)
            }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()
                .contentShape(Rectangle())
                .gesture(
                    DragGesture()
                        .onChanged { value in
                            dragOffset = value.translation
                        }
                        .onEnded { value in
                            panOffset = CGSize(
                                width: panOffset.width + value.translation.width,
                                height: panOffset.height + value.translation.height
                            )
                            dragOffset = .zero
                        }
                )
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in
                            zoomScale = max(0.4, min(3.0, baseZoomScale * value.magnification))
                        }
                        .onEnded { value in
                            zoomScale = max(0.4, min(3.0, baseZoomScale * value.magnification))
                            baseZoomScale = zoomScale
                        }
                )
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        phase = .complete
                    }
                }
        }
    }

    // MARK: - Canvas

    @ViewBuilder
    private func canvas(size: CGSize) -> some View {
        let center = CGPoint(x: size.width / 2, y: size.height * 0.5)
        let hexes = positionedHexes

        ZStack {
            // Background radial glow
            RadialGradient(
                colors: [Forest._600.opacity(0.06), Color.clear],
                center: .center,
                startRadius: 0,
                endRadius: min(size.width, size.height) * 0.5
            )

            // Hex tiles
            ForEach(Array(hexes.enumerated()), id: \.element.id) { idx, hex in
                let pixelPos = hex.coord.toPixel(size: hexSize, gap: hexGap)
                let position = CGPoint(x: center.x + pixelPos.x, y: center.y + pixelPos.y)

                switch hex.kind {
                case .hub(let category):
                    HubHexTileView(category: category, size: hexSize)
                        .position(position)
                        .scaleEffect(phase.hubsVisible ? 1 : 0.3)
                        .opacity(phase.hubsVisible ? 1 : 0)
                        .animation(
                            .spring(response: 0.45, dampingFraction: 0.7)
                                .delay(0.12 + Double(idx) * 0.04),
                            value: phase
                        )

                case .leaf(let item):
                    HexTileView(
                        label: item.label,
                        icon: item.icon,
                        emoji: item.emoji,
                        color: item.color,
                        size: hexSize,
                        onTap: item.filePath.map { path in
                            { onFileSelected?(path) }
                        }
                    )
                    .position(position)
                    .scaleEffect(phase.leavesVisible ? 1 : 0.4)
                    .opacity(phase.leavesVisible ? 1 : 0)
                    .animation(
                        .spring(response: 0.5, dampingFraction: 0.7)
                            .delay(0.20 + Double(idx) * 0.03),
                        value: phase
                    )
                }
            }

            // Center avatar on top of everything
            DinoFaceView(seed: identity?.name ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                .frame(width: 80, height: 80)
                .background(
                    HexagonShape()
                        .fill(VColor.background.opacity(0.9))
                        .frame(width: sqrt(3) * hexSize, height: 2 * hexSize)
                )
                .overlay(
                    HexagonShape()
                        .stroke(Forest._500.opacity(0.4), lineWidth: 2)
                        .frame(width: sqrt(3) * hexSize, height: 2 * hexSize)
                )
                .allowsHitTesting(false)
                .position(center)
                .scaleEffect(phase.centerVisible ? 1 : 0.6)
                .opacity(phase.centerVisible ? 1 : 0)
                .animation(
                    .spring(response: 0.5, dampingFraction: 0.7).delay(0.05),
                    value: phase
                )
        }
    }
}
