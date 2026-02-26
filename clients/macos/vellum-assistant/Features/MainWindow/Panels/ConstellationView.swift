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
        || text.contains("chat") || text.contains("phone") || text.contains("phone call")
        || text.contains("voice call") || text.contains("video call")
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

    if text.contains("browser") || text.contains("computer use") || text.contains("macos")
        || text.contains("watcher") || text.contains("automat") {
        return .automation
    }

    if text.contains("image") || text.contains("screen") || text.contains("media")
        || text.contains("transcri") || text.contains("video") || text.contains("audio")
        || text.contains("recording") {
        return .media
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

// MARK: - Radial Node Types

/// Represents a node positioned in the radial graph layout.
private struct RadialNode: Identifiable {
    let id: String
    let position: CGPoint
    let kind: RadialNodeKind
}

private enum RadialNodeKind {
    case category(SkillCategory)
    case skill(OrbitItem)
}

// MARK: - Edge Line

/// Represents a connection line between two nodes.
private struct EdgeLine: Identifiable {
    let id: String
    let from: CGPoint
    let to: CGPoint
    let color: Color
}

// MARK: - Category Node View

private struct CategoryNodeView: View {
    let category: SkillCategory
    let size: CGFloat

    @State private var isHovered = false

    var body: some View {
        VStack(spacing: 3) {
            Image(systemName: category.icon)
                .font(.system(size: 20, weight: .bold))
                .foregroundColor(category.color)

            Text(category.displayName)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
        }
        .frame(width: size, height: size)
        .background(
            Circle()
                .fill(category.color.opacity(isHovered ? 0.25 : 0.14))
        )
        .overlay(
            Circle()
                .stroke(category.color.opacity(isHovered ? 0.85 : 0.55), lineWidth: isHovered ? 2.5 : 2)
        )
        .clipShape(Circle())
        .contentShape(Circle())
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
    }
}

// MARK: - Skill Node View

private struct SkillNodeView: View {
    let item: OrbitItem
    let size: CGFloat
    var onTap: (() -> Void)?

    @State private var isHovered = false

    private var isTappable: Bool { onTap != nil }

    var body: some View {
        VStack(spacing: 2) {
            if let emoji = item.emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: 18))
            } else {
                Image(systemName: item.icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundColor(item.color)
            }

            Text(item.label)
                .font(VFont.small)
                .foregroundColor(VColor.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: size * 0.85)
        }
        .frame(width: size, height: size)
        .background(
            Circle()
                .fill(item.color.opacity(isHovered ? 0.20 : 0.10))
        )
        .overlay(
            Circle()
                .stroke(item.color.opacity(isHovered ? 0.70 : 0.40), lineWidth: isHovered ? 2 : 1.5)
        )
        .clipShape(Circle())
        .contentShape(Circle())
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

// MARK: - Animation Phase

private enum AnimationPhase: Equatable {
    case hidden
    case center
    case categories
    case complete

    var centerVisible: Bool { self != .hidden }
    var categoriesVisible: Bool { self == .categories || self == .complete }
    var skillsVisible: Bool { self == .complete }
}

// MARK: - Skill Popover View

private struct SkillPopoverView: View {
    let item: OrbitItem

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
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

            if let description = item.description, !description.isEmpty {
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(4)
            }

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
    @State private var selectedNodeId: String?

    // Radial layout constants
    private let categoryRadius: CGFloat = 180
    private let skillRadiusBase: CGFloat = 120
    private let categoryNodeSize: CGFloat = 60
    private let skillNodeSize: CGFloat = 44
    private let centerAvatarSize: CGFloat = 80

    private var existingFiles: [WorkspaceFileNode] {
        workspaceFiles.filter { $0.exists }
    }

    private var groups: [CategoryGroup] {
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

    /// Computes the angular span allocated to each category based on its skill count,
    /// ensuring categories with more skills get proportionally more space to avoid overlaps.
    private func categoryAngles(for groups: [CategoryGroup]) -> [(group: CategoryGroup, angle: CGFloat)] {
        guard !groups.isEmpty else { return [] }

        let totalItems = groups.reduce(0) { $0 + max($1.items.count, 1) }
        var result: [(group: CategoryGroup, angle: CGFloat)] = []
        var currentAngle: CGFloat = -.pi / 2 // Start from top

        for group in groups {
            let weight = CGFloat(max(group.items.count, 1)) / CGFloat(totalItems)
            let sectorAngle = weight * 2 * .pi
            let midAngle = currentAngle + sectorAngle / 2
            result.append((group: group, angle: midAngle))
            currentAngle += sectorAngle
        }

        return result
    }

    /// Builds the full set of radial nodes and edge lines for the graph.
    private func buildGraph(center: CGPoint) -> (nodes: [RadialNode], edges: [EdgeLine]) {
        let layoutGroups = groups
        let angles = categoryAngles(for: layoutGroups)
        var nodes: [RadialNode] = []
        var edges: [EdgeLine] = []

        for entry in angles {
            let group = entry.group
            let angle = entry.angle

            // Category node position on the first ring
            let catX = center.x + categoryRadius * cos(angle)
            let catY = center.y + categoryRadius * sin(angle)
            let catPos = CGPoint(x: catX, y: catY)

            nodes.append(RadialNode(
                id: "cat-\(group.category.rawValue)",
                position: catPos,
                kind: .category(group.category)
            ))

            // Edge from center to category
            edges.append(EdgeLine(
                id: "edge-center-\(group.category.rawValue)",
                from: center,
                to: catPos,
                color: group.category.color
            ))

            // Skill nodes fanned around their parent category
            let itemCount = group.items.count
            guard itemCount > 0 else { continue }

            // Calculate the angular sector this category owns
            let totalItems = layoutGroups.reduce(0) { $0 + max($1.items.count, 1) }
            let sectorWeight = CGFloat(max(itemCount, 1)) / CGFloat(totalItems)
            let sectorAngle = sectorWeight * 2 * .pi

            // Fan spread: use most of the sector but leave some padding
            let fanSpread = min(sectorAngle * 0.75, CGFloat(itemCount - 1) * 0.35 + 0.1)

            // Determine skill radius — push outward slightly for larger groups
            let skillRadius = skillRadiusBase + CGFloat(min(itemCount, 8)) * 5

            for (skillIdx, item) in group.items.enumerated() {
                let skillAngle: CGFloat
                if itemCount == 1 {
                    // Single skill: place directly outward from category
                    skillAngle = angle
                } else {
                    // Distribute evenly within the fan
                    let t = CGFloat(skillIdx) / CGFloat(itemCount - 1) - 0.5
                    skillAngle = angle + t * fanSpread
                }

                let skillX = catX + skillRadius * cos(skillAngle)
                let skillY = catY + skillRadius * sin(skillAngle)
                let skillPos = CGPoint(x: skillX, y: skillY)

                nodes.append(RadialNode(
                    id: item.id,
                    position: skillPos,
                    kind: .skill(item)
                ))

                // Edge from category to skill
                edges.append(EdgeLine(
                    id: "edge-\(group.category.rawValue)-\(skillIdx)",
                    from: catPos,
                    to: skillPos,
                    color: group.category.color
                ))
            }
        }

        return (nodes, edges)
    }

    /// Computes zoom and pan to fit all nodes in the viewport with padding.
    private func fitAll(viewSize: CGSize) {
        let center = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        let graph = buildGraph(center: center)

        guard !graph.nodes.isEmpty else {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) {
                zoomScale = 1.0
                baseZoomScale = 1.0
                panOffset = .zero
                dragOffset = .zero
            }
            return
        }

        var minX = CGFloat.infinity
        var maxX = -CGFloat.infinity
        var minY = CGFloat.infinity
        var maxY = -CGFloat.infinity

        for node in graph.nodes {
            minX = min(minX, node.position.x)
            maxX = max(maxX, node.position.x)
            minY = min(minY, node.position.y)
            maxY = max(maxY, node.position.y)
        }

        // Include center point
        minX = min(minX, center.x)
        maxX = max(maxX, center.x)
        minY = min(minY, center.y)
        maxY = max(maxY, center.y)

        let padding: CGFloat = 80
        let contentWidth = (maxX - minX) + padding * 2
        let contentHeight = (maxY - minY) + padding * 2

        guard contentWidth > 0, contentHeight > 0 else { return }

        let fitZoom = min(viewSize.width / contentWidth, viewSize.height / contentHeight)
        let clampedZoom = max(0.4, min(3.0, fitZoom))

        // Content centroid relative to view center
        let contentCenterX = (minX + maxX) / 2 - center.x
        let contentCenterY = (minY + maxY) / 2 - center.y

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

                // Dismiss layer for popover
                if selectedSkillItem != nil {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(VAnimation.fast) {
                                selectedSkillItem = nil
                                selectedNodeId = nil
                            }
                        }
                }

                // Skill popover overlay — derive position from current layout so it
                // tracks the node even after panel resize or recenter.
                if let selected = selectedSkillItem, let nodeId = selectedNodeId {
                    let canvasCenter = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
                    let currentGraph = buildGraph(center: canvasCenter)

                    if let nodePos = currentGraph.nodes.first(where: { $0.id == nodeId })?.position {
                        let viewCenter = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
                        let scaledX = viewCenter.x + (nodePos.x - canvasCenter.x) * zoomScale + totalOffset.width
                        let scaledY = viewCenter.y + (nodePos.y - canvasCenter.y) * zoomScale + totalOffset.height - 60

                        SkillPopoverView(item: selected)
                            .position(x: scaledX, y: scaledY)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
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
                    // Staggered animation: center -> categories -> skills
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) {
                            phase = .center
                        }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) {
                            phase = .categories
                        }
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) {
                            phase = .complete
                        }
                    }
                    // Auto-fit into viewport after animation settles
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                        fitAll(viewSize: proxy.size)
                    }
                }
                #if os(macOS)
                .onKeyPress(.escape) {
                    if selectedSkillItem != nil {
                        withAnimation(VAnimation.fast) {
                            selectedSkillItem = nil
                            selectedNodeId = nil
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
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let graph = buildGraph(center: center)

        ZStack {
            // Background radial glow
            RadialGradient(
                colors: [Forest._600.opacity(0.06), Color.clear],
                center: .center,
                startRadius: 0,
                endRadius: min(size.width, size.height) * 0.5
            )

            // Edge lines drawn first (behind nodes)
            Canvas { context, _ in
                for edge in graph.edges {
                    var path = Path()
                    path.move(to: edge.from)
                    path.addLine(to: edge.to)
                    context.stroke(
                        path,
                        with: .color(edge.color.opacity(phase.categoriesVisible ? 0.25 : 0.0)),
                        lineWidth: 1.5
                    )
                }
            }
            .allowsHitTesting(false)
            .animation(.easeInOut(duration: 0.4), value: phase)

            // Category and skill nodes
            ForEach(Array(graph.nodes.enumerated()), id: \.element.id) { idx, node in
                switch node.kind {
                case .category(let category):
                    CategoryNodeView(category: category, size: categoryNodeSize)
                        .position(node.position)
                        .scaleEffect(phase.categoriesVisible ? 1 : 0.3)
                        .opacity(phase.categoriesVisible ? 1 : 0)
                        .animation(
                            .spring(response: 0.45, dampingFraction: 0.7)
                                .delay(Double(idx) * 0.04),
                            value: phase
                        )

                case .skill(let item):
                    SkillNodeView(
                        item: item,
                        size: skillNodeSize,
                        onTap: item.filePath != nil
                            ? { onFileSelected?(item.filePath!) }
                            : item.description != nil
                                ? {
                                    withAnimation(VAnimation.fast) {
                                        if selectedSkillItem?.id == item.id {
                                            selectedSkillItem = nil
                                            selectedNodeId = nil
                                        } else {
                                            selectedSkillItem = item
                                            selectedNodeId = node.id
                                        }
                                    }
                                }
                                : nil
                    )
                    .position(node.position)
                    .scaleEffect(phase.skillsVisible ? 1 : 0.4)
                    .opacity(phase.skillsVisible ? 1 : 0)
                    .animation(
                        .spring(response: 0.5, dampingFraction: 0.7)
                            .delay(0.08 + Double(idx) * 0.02),
                        value: phase
                    )
                }
            }

            // Center avatar on top of everything
            DinoFaceView(seed: identity?.name ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                .frame(width: centerAvatarSize, height: centerAvatarSize)
                .background(
                    Circle()
                        .fill(VColor.background.opacity(0.9))
                        .frame(width: centerAvatarSize + 16, height: centerAvatarSize + 16)
                )
                .overlay(
                    Circle()
                        .stroke(Forest._500.opacity(0.4), lineWidth: 2)
                        .frame(width: centerAvatarSize + 16, height: centerAvatarSize + 16)
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
