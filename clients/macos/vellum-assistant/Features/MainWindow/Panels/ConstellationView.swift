import SwiftUI
import VellumAssistantShared

// MARK: - Skill Category

private enum SkillCategory: String, CaseIterable {
    case communication
    case productivity
    case development
    case media
    case automation
    case webSocial
    case knowledge
    case integration

    var displayName: String {
        switch self {
        case .communication: return "Communication"
        case .productivity: return "Productivity"
        case .development: return "Development"
        case .media: return "Media"
        case .automation: return "Automation"
        case .webSocial: return "Web & Social"
        case .knowledge: return "Knowledge"
        case .integration: return "Integration"
        }
    }

    var color: Color {
        switch self {
        case .communication: return Color(hex: 0x8B5DAA) // purple
        case .productivity: return Color(hex: 0x4682B4)   // steel blue
        case .development: return Color(hex: 0xC1421B)    // red
        case .media: return Color(hex: 0xD4A017)          // gold
        case .automation: return Color(hex: 0x2E8B57)     // sea green
        case .webSocial: return Color(hex: 0xCD853F)      // peru/tan
        case .knowledge: return Color(hex: 0x6B8E23)      // olive
        case .integration: return Color(hex: 0x708090)    // slate gray
        }
    }

    var icon: String {
        switch self {
        case .communication: return "bubble.left.fill"
        case .productivity: return "checklist"
        case .development: return "hammer.fill"
        case .media: return "film.fill"
        case .automation: return "bolt.fill"
        case .webSocial: return "globe"
        case .knowledge: return "book.fill"
        case .integration: return "link"
        }
    }

    var emoji: String {
        switch self {
        case .communication: return "\u{1F4AC}"
        case .productivity: return "\u{1F4CB}"
        case .development: return "\u{1F528}"
        case .media: return "\u{1F3AC}"
        case .automation: return "\u{26A1}"
        case .webSocial: return "\u{1F310}"
        case .knowledge: return "\u{1F4DA}"
        case .integration: return "\u{1F517}"
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
    let description: String?
    let category: SkillCategory?
}

private struct CategoryGroup: Identifiable {
    var id: String { category.rawValue }
    let category: SkillCategory
    var items: [OrbitItem]
}

// MARK: - Category Inference

private func inferCategory(_ skill: SkillInfo) -> SkillCategory {
    let text = (skill.name + " " + skill.description).lowercased()

    if text.contains("email") || text.contains("message") || text.contains("messaging")
        || text.contains("chat") || text.contains("phone") || text.contains("call")
        || text.contains("contact") || text.contains("notification") || text.contains("followup")
        || text.contains("sms") || text.contains("slack") || text.contains("telegram") {
        return .communication
    }

    if text.contains("task") || text.contains("calendar") || text.contains("reminder")
        || text.contains("schedule") || text.contains("document") || text.contains("playbook")
        || text.contains("notion") {
        return .productivity
    }

    if text.contains("code") || text.contains("app builder") || text.contains("github")
        || text.contains("developer") || text.contains("programming") || text.contains("debug")
        || text.contains("typescript") || text.contains("frontend") || text.contains("subagent")
        || text.contains("api mapping") || text.contains("cli discovery") {
        return .development
    }

    if text.contains("image") || text.contains("screen") || text.contains("media")
        || text.contains("transcri") || text.contains("video") || text.contains("audio")
        || text.contains("recording") {
        return .media
    }

    if text.contains("browser") || text.contains("computer use") || text.contains("macos")
        || text.contains("watcher") || text.contains("automat") {
        return .automation
    }

    if text.contains("x.com") || text.contains("twitter") || text.contains("public ingress")
        || text.contains("influencer") || text.contains("doordash") || text.contains("amazon")
        || text.contains("restaurant") {
        return .webSocial
    }

    if text.contains("knowledge") || text.contains("weather") || text.contains("start the day")
        || text.contains("skills catalog") || text.contains("self upgrade")
        || text.contains("briefing") {
        return .knowledge
    }

    if text.contains("oauth") || text.contains("setup") || text.contains("configure")
        || text.contains("connect") || text.contains("webhook") {
        return .integration
    }

    return .knowledge
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

/// Hub positions for category placement. Ring 1 provides 6 positions adjacent to center;
/// 2 evenly-spaced ring 2 positions fill out support for up to 8 categories.
private let hubCoordPool: [HexCoord] = [
    // Ring 1 (6 positions)
    HexCoord(q: 1, r: 0),
    HexCoord(q: 0, r: 1),
    HexCoord(q: -1, r: 1),
    HexCoord(q: -1, r: 0),
    HexCoord(q: 0, r: -1),
    HexCoord(q: 1, r: -1),
    // Ring 2 overflow (2 positions, spaced opposite each other)
    HexCoord(q: 2, r: -1),
    HexCoord(q: -2, r: 1),
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

        VStack(spacing: 3) {
            if let emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 24))
            } else {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundColor(color)
            }

            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: hexWidth * 0.75)
        }
        .frame(width: hexWidth, height: hexHeight)
        .background(
            HexagonShape()
                .fill(color.opacity(isHovered ? 0.22 : 0.12))
        )
        .overlay(
            HexagonShape()
                .stroke(color.opacity(isHovered ? 0.75 : 0.45), lineWidth: isHovered ? 2 : 1.5)
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
                .font(.system(size: 26, weight: .bold))
                .foregroundColor(category.color)

            Text(category.displayName)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
        }
        .padding(4)
        .frame(width: hexWidth, height: hexHeight)
        .background(
            HexagonShape()
                .fill(category.color.opacity(isHovered ? 0.30 : 0.20))
        )
        .overlay(
            HexagonShape()
                .stroke(category.color.opacity(isHovered ? 0.90 : 0.65), lineWidth: isHovered ? 3 : 2.5)
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

// MARK: - Skill Popover View

private struct SkillPopoverView: View {
    let item: OrbitItem

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Emoji/icon + name row
            HStack(spacing: VSpacing.sm) {
                if let emoji = item.emoji, !emoji.isEmpty {
                    Text(emoji)
                        .font(.system(size: 20))
                } else {
                    Image(systemName: item.icon)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(item.color)
                }

                Text(item.label)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
            }

            // Description
            if let description = item.description, !description.isEmpty {
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(4)
            }

            // Category badge
            if let category = item.category {
                Text(category.displayName)
                    .font(VFont.small)
                    .foregroundColor(category.color)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(
                        Capsule()
                            .fill(category.color.opacity(0.15))
                    )
            }
        }
        .padding(VSpacing.md)
        .frame(maxWidth: 250, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .vShadow(VShadow.md)
    }
}

// ViewportToolbarButton removed — using VIconButton from design system instead.

// MARK: - Constellation View

struct ConstellationView: View {
    let identity: IdentityInfo?
    let skills: [SkillInfo]
    let workspaceFiles: [WorkspaceFileNode]
    var onFileSelected: ((String) -> Void)?
    @Binding var isFullscreen: Bool
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var phase: AnimationPhase = .hidden
    @State private var panOffset: CGSize = .zero
    @State private var dragOffset: CGSize = .zero
    @State private var zoomScale: CGFloat = 1.0
    @State private var baseZoomScale: CGFloat = 1.0
    @State private var selectedSkillItem: OrbitItem?
    @State private var selectedHexCoord: HexCoord?

    // Uniform hex size for both positioning and rendering — hubs are
    // visually distinguished via styling (heavier border, higher fill
    // opacity, larger font) rather than a physically bigger hexagon.
    private let hexSize: CGFloat = 62
    private let hexGap: CGFloat = 4

    private var existingFiles: [WorkspaceFileNode] {
        workspaceFiles.filter { $0.exists }
    }

    private var groups: [CategoryGroup] {
        // Workspace files (IDENTITY.md, SOUL.md, etc.) are categorized under Knowledge
        let fileItems = existingFiles.enumerated().map { idx, node in
            let path: String? = node.label.hasSuffix(".md") ? node.path : nil
            return OrbitItem(
                id: "workspace-\(idx)", label: node.label, icon: SkillCategory.knowledge.icon,
                emoji: nil, color: SkillCategory.knowledge.color, filePath: path,
                description: nil, category: .knowledge
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
                filePath: nil,
                description: skill.description,
                category: cat
            )
            categoryMap[cat, default: []].append(item)
        }

        // Merge workspace file items into the knowledge category
        if !fileItems.isEmpty {
            categoryMap[.knowledge, default: []].insert(contentsOf: fileItems, at: 0)
        }

        var result: [CategoryGroup] = []
        for cat in SkillCategory.allCases {
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

        // Place category hubs using the hub coordinate pool (ring 1 + ring 2 overflow)
        let hubCount = min(layoutGroups.count, hubCoordPool.count)
        var hubCoords: [HexCoord] = []

        for i in 0..<hubCount {
            let coord = hubCoordPool[i]
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

    /// Computes zoom and pan to fit all hexes in the viewport with padding.
    private func fitAll(viewSize: CGSize) {
        let hexes = positionedHexes

        // When no skills/files are loaded the center avatar is still rendered.
        // Reset to default viewport so the user can recover after drag/zoom.
        guard !hexes.isEmpty else {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) {
                zoomScale = 1.0
                baseZoomScale = 1.0
                panOffset = .zero
                dragOffset = .zero
            }
            return
        }

        // Compute bounding box of all hex pixel positions
        var minX = CGFloat.infinity
        var maxX = -CGFloat.infinity
        var minY = CGFloat.infinity
        var maxY = -CGFloat.infinity

        for hex in hexes {
            let pos = hex.coord.toPixel(size: hexSize, gap: hexGap)
            minX = min(minX, pos.x)
            maxX = max(maxX, pos.x)
            minY = min(minY, pos.y)
            maxY = max(maxY, pos.y)
        }
        // Also include center hex at (0,0)
        minX = min(minX, 0)
        maxX = max(maxX, 0)
        minY = min(minY, 0)
        maxY = max(maxY, 0)

        // Add padding around the bounding box
        let padding = hexSize * 2
        let contentWidth = (maxX - minX) + padding * 2
        let contentHeight = (maxY - minY) + padding * 2

        guard contentWidth > 0, contentHeight > 0 else { return }

        let fitZoom = min(viewSize.width / contentWidth, viewSize.height / contentHeight)
        let clampedZoom = max(0.4, min(3.0, fitZoom))

        // Center of the bounding box in canvas-local coords (relative to
        // the canvas center, which is at viewSize/2). The hex pixel positions
        // are already relative to the canvas center, so the content centroid
        // offset is just the midpoint of the bounding box.
        let contentCenterX = (minX + maxX) / 2
        let contentCenterY = (minY + maxY) / 2

        // Pan offset to re-center the content centroid in the viewport.
        // After scaling, the centroid is at (contentCenter * zoom) from the
        // view center, so we pan by the negative of that.
        let targetPanX = -contentCenterX * clampedZoom
        let targetPanY = -contentCenterY * clampedZoom

        withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) {
            zoomScale = clampedZoom
            baseZoomScale = clampedZoom
            panOffset = CGSize(width: targetPanX, height: targetPanY)
            dragOffset = .zero
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let totalOffset = CGSize(
                width: panOffset.width + dragOffset.width,
                height: panOffset.height + dragOffset.height
            )
            ZStack {
                canvas(size: proxy.size)
                    .scaleEffect(zoomScale)
                    .offset(totalOffset)

                // Dismiss layer: clear tap target behind the popover
                if selectedSkillItem != nil {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(VAnimation.fast) {
                                selectedSkillItem = nil
                                selectedHexCoord = nil
                            }
                        }
                }

                // Skill popover overlay — recompute pixel position from the
                // stored hex coord each render cycle so the popover tracks the
                // correct hex even after window resize or geometry changes.
                if let selected = selectedSkillItem, let coord = selectedHexCoord {
                    let canvasCenter = CGPoint(x: proxy.size.width / 2, y: proxy.size.height * 0.5)
                    let pixelPos = coord.toPixel(size: hexSize, gap: hexGap)
                    let anchorInCanvas = CGPoint(x: canvasCenter.x + pixelPos.x, y: canvasCenter.y + pixelPos.y)

                    let viewCenter = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
                    let scaledX = viewCenter.x + (anchorInCanvas.x - viewCenter.x) * zoomScale + totalOffset.width
                    let scaledY = viewCenter.y + (anchorInCanvas.y - viewCenter.y) * zoomScale + totalOffset.height - 80

                    SkillPopoverView(item: selected)
                        .position(x: scaledX, y: scaledY)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()
                .contentShape(Rectangle())
                .overlay(alignment: .topLeading) {
                    fullscreenToggle
                        .padding(VSpacing.lg)
                }
                .overlay(alignment: .bottomTrailing) {
                    viewportControls(viewSize: proxy.size)
                        .padding(VSpacing.lg)
                }
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
                    // Auto-fit all hexes into the viewport on initial load
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        fitAll(viewSize: proxy.size)
                    }
                }
                #if os(macOS)
                .onKeyPress(.escape) {
                    if selectedSkillItem != nil {
                        withAnimation(VAnimation.fast) {
                            selectedSkillItem = nil
                            selectedHexCoord = nil
                        }
                        return .handled
                    }
                    return .ignored
                }
                #endif
        }
    }

    // MARK: - Fullscreen Toggle (top-left)

    private var fullscreenToggle: some View {
        VIconButton(
            label: isFullscreen ? "Collapse" : "Expand",
            icon: isFullscreen
                ? "arrow.down.right.and.arrow.up.left"
                : "arrow.up.left.and.arrow.down.right",
            iconOnly: true,
            tooltip: isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
        ) {
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                isFullscreen.toggle()
            }
        }
    }

    // MARK: - Viewport Controls (bottom-right)

    @ViewBuilder
    private func viewportControls(viewSize: CGSize) -> some View {
        HStack(spacing: VSpacing.xxs) {
            VIconButton(label: "Zoom in", icon: "plus.magnifyingglass", iconOnly: true, tooltip: "Zoom in") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    zoomScale = min(3.0, zoomScale + 0.25)
                    baseZoomScale = zoomScale
                }
            }

            VIconButton(label: "Zoom out", icon: "minus.magnifyingglass", iconOnly: true, tooltip: "Zoom out") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    zoomScale = max(0.4, zoomScale - 0.25)
                    baseZoomScale = zoomScale
                }
            }

            VIconButton(label: "Fit all", icon: "viewfinder", iconOnly: true, tooltip: "Fit all skills") {
                fitAll(viewSize: viewSize)
            }
        }
        .padding(VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface.opacity(0.85))
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
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
                        onTap: item.filePath != nil
                            ? { onFileSelected?(item.filePath!) }
                            : item.description != nil
                                ? {
                                    withAnimation(VAnimation.fast) {
                                        if selectedSkillItem?.id == item.id {
                                            selectedSkillItem = nil
                                            selectedHexCoord = nil
                                        } else {
                                            selectedSkillItem = item
                                            selectedHexCoord = hex.coord
                                        }
                                    }
                                }
                                : nil
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
