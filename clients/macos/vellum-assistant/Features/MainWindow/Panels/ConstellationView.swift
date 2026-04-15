import SwiftUI
import VellumAssistantShared

// MARK: - Skill Category

enum SkillCategory: String, CaseIterable {
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
        case .communication: return VColor.funPurple
        case .productivity: return VColor.funTeal
        case .development: return VColor.funRed
        case .media: return VColor.funPink
        case .automation: return VColor.funYellow
        case .webSocial: return VColor.funCoral
        case .knowledge: return VColor.funGreen
        case .integration: return VColor.primaryBase
        }
    }

    var icon: VIcon {
        switch self {
        case .communication: return .messageCircle
        case .productivity: return .listChecks
        case .development: return .wrench
        case .media: return .film
        case .automation: return .zap
        case .webSocial: return .globe
        case .knowledge: return .bookOpen
        case .integration: return .link
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

private enum OrbitItemKind {
    case skill
    case workspaceFile
}

private struct OrbitItem: Identifiable {
    let id: String
    let label: String
    let icon: VIcon
    let emoji: String?
    let color: Color
    let filePath: String?
    let description: String?
    let category: SkillCategory?
    let kind: OrbitItemKind

    init(
        id: String, label: String, icon: VIcon, emoji: String? = nil,
        color: Color, filePath: String? = nil, description: String? = nil,
        category: SkillCategory? = nil, kind: OrbitItemKind = .skill
    ) {
        self.id = id
        self.label = label
        self.icon = icon
        self.emoji = emoji
        self.color = color
        self.filePath = filePath
        self.description = description
        self.category = category
        self.kind = kind
    }
}

private struct CategoryGroup: Identifiable {
    var id: String { category.rawValue }
    let category: SkillCategory
    var items: [OrbitItem]
}

// MARK: - Category Inference

func inferCategory(_ skill: SkillInfo) -> SkillCategory {
    let text = (skill.name + " " + skill.description).lowercased()

    if text.contains("email") || text.contains("message") || text.contains("messaging")
        || text.contains("chat") || text.contains("phone") || text.contains("phone call")
        || text.contains("voice call") || text.contains("video call")
        || text.contains("contact") || text.contains("notification") || text.contains("followup")
        || text.contains("slack") || text.contains("telegram") {
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

// MARK: - Sub-Category Definitions

private struct SubCategoryDef {
    let label: String
    let emoji: String
    let skillIds: Set<String>
}

private let subCategoryMap: [SkillCategory: [SubCategoryDef]] = [
    .communication: [
        SubCategoryDef(label: "Messaging", emoji: "\u{1F4AC}", skillIds: ["messaging", "agentmail", "email-setup"]),
        SubCategoryDef(label: "Calling", emoji: "\u{1F4DE}", skillIds: ["phone-calls", "notifications"]),
        SubCategoryDef(label: "People", emoji: "\u{1F465}", skillIds: ["contacts", "followups"]),
    ],
    .productivity: [
        SubCategoryDef(label: "Planning", emoji: "\u{1F4C5}", skillIds: ["google-calendar", "schedule"]),
        SubCategoryDef(label: "Work", emoji: "\u{1F4CB}", skillIds: ["document", "tasks", "playbooks"]),
    ],
    .development: [
        SubCategoryDef(label: "Coding", emoji: "\u{1F4BB}", skillIds: ["typescript-eval", "frontend-design"]),
        SubCategoryDef(label: "Dev Tools", emoji: "\u{1F527}", skillIds: ["api-mapping", "cli-discover", "subagent", "app-builder"]),
    ],
    .automation: [
        SubCategoryDef(label: "Control", emoji: "\u{1F3AE}", skillIds: ["computer-use", "macos-automation", "browser"]),
        SubCategoryDef(label: "Triggers", emoji: "\u{23F0}", skillIds: ["watcher", "time-based-actions"]),
    ],
    .webSocial: [
        SubCategoryDef(label: "Social", emoji: "\u{1F4F1}", skillIds: ["influencer"]),
        SubCategoryDef(label: "Services", emoji: "\u{1F6D2}", skillIds: ["amazon", "doordash", "restaurant-reservation"]),
    ],
    .knowledge: [
        SubCategoryDef(label: "Learning", emoji: "\u{1F9E0}", skillIds: ["knowledge-graph", "skills-catalog", "self-upgrade"]),
        SubCategoryDef(label: "Daily", emoji: "\u{2600}\u{FE0F}", skillIds: ["start-the-day", "weather"]),
    ],
]

// MARK: - Tree Node Types

private enum TreeNodeKind {
    case center
    case category(SkillCategory)
    case subCategory(label: String, emoji: String, category: SkillCategory)
    case skill(OrbitItem)
}

private struct TreeNode: Identifiable {
    let id: String
    let kind: TreeNodeKind
    let parentId: String?
    let depth: Int // 0=center, 1=category, 2=subCategory or skill, 3=skill under subCategory
    var position: CGPoint
    let radius: CGFloat
}

// MARK: - Edge Line

private struct EdgeLine: Identifiable {
    let id: String
    let fromId: String
    let toId: String
    let color: Color
}

// MARK: - Category Node View

private struct CategoryNodeView: View {
    let category: SkillCategory
    let size: CGFloat

    @State private var isHovered = false

    var body: some View {
        VStack(spacing: 4) {
            VIconView(category.icon, size: 24)
                .foregroundStyle(category.color)

            Text(category.displayName)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: size * 0.85)
        }
        .frame(width: size, height: size)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.xl).fill(VColor.surfaceOverlay)
                RoundedRectangle(cornerRadius: VRadius.xl).fill(category.color.opacity(isHovered ? 0.25 : 0.14))
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(category.color.opacity(isHovered ? 0.85 : 0.55), lineWidth: isHovered ? 2.5 : 2)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .contentShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .nativeTooltip(category.displayName)
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
    }
}

// MARK: - Sub-Category Node View

private struct SubCategoryNodeView: View {
    let label: String
    let emoji: String
    let category: SkillCategory
    let size: CGFloat

    @State private var isHovered = false

    var body: some View {
        VStack(spacing: 2) {
            Text(emoji)
                .font(.system(size: 16))

            Text(label)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: size * 0.85)
        }
        .frame(width: size, height: size)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.lg).fill(VColor.surfaceOverlay)
                RoundedRectangle(cornerRadius: VRadius.lg).fill(category.color.opacity(isHovered ? 0.20 : 0.10))
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(
                    category.color.opacity(isHovered ? 0.70 : 0.40),
                    style: StrokeStyle(lineWidth: isHovered ? 2 : 1.5, dash: [6, 4])
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .contentShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .nativeTooltip(label)
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
    var onDoubleTap: (() -> Void)?
    var onTap: (() -> Void)?

    @State private var isHovered = false

    private var isTappable: Bool { onTap != nil }

    private var isDiamond: Bool { item.kind == .skill }

    var body: some View {
        let content = VStack(spacing: 3) {
            if let emoji = item.emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: isDiamond ? 18 : 22))
            } else {
                VIconView(item.icon, size: isDiamond ? 14 : 18)
                    .foregroundStyle(item.color)
            }

            Text(item.label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(isDiamond ? 1 : 2)
                .truncationMode(.tail)
                .multilineTextAlignment(.center)
                .frame(maxWidth: size * (isDiamond ? 0.62 : 0.82))
        }
        .frame(width: size, height: size)

        Group {
            if isDiamond {
                // Skills: diamond (rotated square) shape
                content
                    .rotationEffect(.degrees(-45)) // counter-rotate content upright
                    .background(
                        ZStack {
                            RoundedRectangle(cornerRadius: VRadius.sm).fill(VColor.surfaceOverlay)
                            RoundedRectangle(cornerRadius: VRadius.sm).fill(item.color.opacity(isHovered ? 0.20 : 0.10))
                        }
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.sm)
                            .stroke(item.color.opacity(isHovered ? 0.70 : 0.40), lineWidth: isHovered ? 2 : 1.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .contentShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    .rotationEffect(.degrees(45)) // rotate the whole node to diamond
            } else {
                // Files: circle shape
                content
                    .background(
                        ZStack {
                            Circle().fill(VColor.surfaceOverlay)
                            Circle().fill(item.color.opacity(isHovered ? 0.20 : 0.10))
                        }
                    )
                    .overlay(
                        Circle()
                            .stroke(item.color.opacity(isHovered ? 0.70 : 0.40), lineWidth: isHovered ? 2 : 1.5)
                    )
                    .clipShape(Circle())
                    .contentShape(Circle())
            }
        }
        .nativeTooltip(item.kind == .workspaceFile ? "File: \(item.label)" : "Skill: \(item.label)")
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
        .if(isTappable) { view in
            view.pointerCursor()
        }
        .onTapGesture(count: 2) {
            onDoubleTap?()
        }
        .onTapGesture {
            onTap?()
        }
    }
}

// MARK: - Node Popover View (Unified)

private struct NodePopoverView: View {
    let item: OrbitItem
    var onViewDetails: (() -> Void)?

    /// Icon for the header based on the item's kind.
    private var headerIcon: VIcon {
        switch item.kind {
        case .skill: return item.icon
        case .workspaceFile: return .file
        }
    }

    private var tagLabel: String {
        switch item.kind {
        case .skill: return "Skill"
        case .workspaceFile: return "Workspace"
        }
    }

    private var tagIcon: VIcon {
        switch item.kind {
        case .skill: return .zap
        case .workspaceFile: return .file
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Type tag + View Details on same line
            HStack {
                VTag(tagLabel, color: VColor.primaryBase, icon: tagIcon)
                Spacer()
                if let onViewDetails {
                    VButton(label: "View Details", style: .ghost, size: .compact) {
                        onViewDetails()
                    }
                }
            }

            // Name/title with icon or emoji
            HStack(spacing: VSpacing.sm) {
                if item.kind == .skill, let emoji = item.emoji, !emoji.isEmpty {
                    Text(emoji)
                        .font(.system(size: 20))
                } else {
                    VIconView(headerIcon, size: 14)
                        .foregroundStyle(item.color)
                }

                Text(item.label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
            }

            // Description
            if let description = item.description, !description.isEmpty {
                Text(description)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(4)
            }
        }
        .padding(VSpacing.md)
        .frame(maxWidth: 260, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceBase)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .vShadow(VShadow.md)
    }
}

// MARK: - Animation Phase

private enum AnimationPhase: Equatable {
    case hidden
    case center
    case categories
    case subCategories
    case complete

    var centerVisible: Bool { self != .hidden }
    var categoriesVisible: Bool {
        self == .categories || self == .subCategories || self == .complete
    }
    var subCategoriesVisible: Bool {
        self == .subCategories || self == .complete
    }
    var skillsVisible: Bool { self == .complete }
}


// MARK: - Overlap Resolution

/// Pushes a proposed position away from any overlapping existing nodes.
/// Iterates until no overlaps remain or max attempts reached.
private func resolveOverlap(
    proposed: CGPoint,
    nodeRadius: CGFloat,
    existingNodes: [TreeNode],
    gap: CGFloat
) -> CGPoint {
    var pos = proposed

    for _ in 0..<30 {
        var worstOverlap: CGFloat = 0
        var pushX: CGFloat = 0
        var pushY: CGFloat = 0

        for existing in existingNodes {
            let dx = pos.x - existing.position.x
            let dy = pos.y - existing.position.y
            let dist = sqrt(dx * dx + dy * dy)
            let minDist = nodeRadius + existing.radius + gap
            let overlap = minDist - dist
            if overlap > worstOverlap {
                worstOverlap = overlap
                if dist < 0.1 {
                    // Coincident nodes — push in an arbitrary direction
                    pushX = overlap + 1
                    pushY = 0
                } else {
                    // Push directly away from the overlapping node
                    pushX = dx / dist * (overlap + 1)
                    pushY = dy / dist * (overlap + 1)
                }
            }
        }

        if worstOverlap <= 0 { break }
        pos.x += pushX
        pos.y += pushY
    }

    return pos
}

// MARK: - Hierarchical Radial Tree Layout

/// Builds a deterministic hierarchical radial tree from category groups.
/// Each category's subtree stays within its angular sector to prevent cross-category overlap.
/// Skills are placed in compact grids extending outward from their parent.
/// Every node is checked against all previously-placed nodes to prevent overlap.
private func buildTree(center: CGPoint, groups: [CategoryGroup], centerSize: CGFloat = 90) -> (nodes: [TreeNode], edges: [EdgeLine]) {
    var nodes: [TreeNode] = []
    var edges: [EdgeLine] = []

    let catSize: CGFloat = 80
    let subCatSize: CGFloat = 56
    let skillSize: CGFloat = 64
    let nodeGap: CGFloat = 10

    let centerToCatRadius: CGFloat = 200
    let catToSubCatRadius: CGFloat = 160
    let skillOutwardDist: CGFloat = 160

    // Center node
    nodes.append(TreeNode(
        id: "__center__",
        kind: .center,
        parentId: nil,
        depth: 0,
        position: center,
        radius: centerSize / 2
    ))

    guard !groups.isEmpty else { return (nodes, edges) }

    let catCount = groups.count
    let sectorAngle = 2 * .pi / CGFloat(catCount)

    for (catIdx, group) in groups.enumerated() {
        let catAngle = -.pi / 2 + CGFloat(catIdx) * sectorAngle

        let catId = "cat-\(group.category.rawValue)"
        let catPos = resolveOverlap(
            proposed: CGPoint(
                x: center.x + centerToCatRadius * cos(catAngle),
                y: center.y + centerToCatRadius * sin(catAngle)
            ),
            nodeRadius: catSize / 2,
            existingNodes: nodes,
            gap: nodeGap
        )

        nodes.append(TreeNode(
            id: catId,
            kind: .category(group.category),
            parentId: "__center__",
            depth: 1,
            position: catPos,
            radius: catSize / 2
        ))

        edges.append(EdgeLine(
            id: "edge-center-\(group.category.rawValue)",
            fromId: "__center__",
            toId: catId,
            color: group.category.color
        ))

        if let subCats = subCategoryMap[group.category], !subCats.isEmpty {
            var subGroupItems: [(def: SubCategoryDef, items: [OrbitItem])] = []
            var assignedIds: Set<String> = []

            for subCat in subCats {
                let matching = group.items.filter { subCat.skillIds.contains($0.id) }
                if !matching.isEmpty {
                    subGroupItems.append((def: subCat, items: matching))
                    matching.forEach { assignedIds.insert($0.id) }
                }
            }

            let unmatched = group.items.filter { !assignedIds.contains($0.id) }
            if !unmatched.isEmpty {
                if subGroupItems.isEmpty {
                    placeSkillCluster(
                        items: group.items, parentId: catId, parentPos: catPos,
                        outwardAngle: catAngle, outwardDist: skillOutwardDist,
                        childSize: skillSize, gap: nodeGap, depth: 2,
                        category: group.category, edgePrefix: group.category.rawValue,
                        nodes: &nodes, edges: &edges
                    )
                    continue
                } else {
                    subGroupItems[subGroupItems.count - 1].items.append(contentsOf: unmatched)
                }
            }

            // Subcategory spread: use 55% of sector to leave gap between adjacent categories
            let subCatCount = subGroupItems.count
            let maxSubSpread = sectorAngle * 0.55
            let subSpread: CGFloat = subCatCount <= 1 ? 0 : min(maxSubSpread, CGFloat(subCatCount - 1) * 0.35)

            for (subIdx, subGroup) in subGroupItems.enumerated() {
                let subAngle: CGFloat
                if subCatCount == 1 {
                    subAngle = catAngle
                } else {
                    let t = CGFloat(subIdx) / CGFloat(subCatCount - 1) - 0.5
                    subAngle = catAngle + t * subSpread * 2
                }

                let subCatId = "subcat-\(group.category.rawValue)-\(subIdx)"
                let subCatPos = resolveOverlap(
                    proposed: CGPoint(
                        x: catPos.x + catToSubCatRadius * cos(subAngle),
                        y: catPos.y + catToSubCatRadius * sin(subAngle)
                    ),
                    nodeRadius: subCatSize / 2,
                    existingNodes: nodes,
                    gap: nodeGap
                )

                nodes.append(TreeNode(
                    id: subCatId,
                    kind: .subCategory(label: subGroup.def.label, emoji: subGroup.def.emoji, category: group.category),
                    parentId: catId,
                    depth: 2,
                    position: subCatPos,
                    radius: subCatSize / 2
                ))

                edges.append(EdgeLine(
                    id: "edge-\(group.category.rawValue)-sub-\(subIdx)",
                    fromId: catId,
                    toId: subCatId,
                    color: group.category.color
                ))

                placeSkillCluster(
                    items: subGroup.items, parentId: subCatId, parentPos: subCatPos,
                    outwardAngle: subAngle, outwardDist: skillOutwardDist,
                    childSize: skillSize, gap: nodeGap, depth: 3,
                    category: group.category, edgePrefix: subCatId,
                    nodes: &nodes, edges: &edges
                )
            }
        } else {
            placeSkillCluster(
                items: group.items, parentId: catId, parentPos: catPos,
                outwardAngle: catAngle, outwardDist: skillOutwardDist,
                childSize: skillSize, gap: nodeGap, depth: 2,
                category: group.category, edgePrefix: group.category.rawValue,
                nodes: &nodes, edges: &edges
            )
        }
    }

    return (nodes, edges)
}

/// Place skill nodes in a compact cluster extending outward from their parent.
/// Items wrap into rows of 3, each row extending further outward, with staggering
/// to create a tight hex-grid-like packing. Each node is checked for overlap with
/// all previously-placed nodes and pushed away if necessary.
private func placeSkillCluster(
    items: [OrbitItem], parentId: String, parentPos: CGPoint,
    outwardAngle: CGFloat, outwardDist: CGFloat,
    childSize: CGFloat, gap: CGFloat, depth: Int,
    category: SkillCategory, edgePrefix: String,
    nodes: inout [TreeNode], edges: inout [EdgeLine]
) {
    guard !items.isEmpty else { return }

    let spacing = childSize + gap
    let outX = cos(outwardAngle)
    let outY = sin(outwardAngle)
    let perpX = -outY
    let perpY = outX

    // Max 3 per row to keep perpendicular spread narrow
    let maxPerRow = 3
    let rowDepthGap = spacing * 0.88

    for (idx, item) in items.enumerated() {
        let row = idx / maxPerRow
        let col = idx % maxPerRow
        let colsInRow = min(maxPerRow, items.count - row * maxPerRow)

        let perpOffset = (CGFloat(col) - CGFloat(colsInRow - 1) / 2) * spacing
        // Stagger odd rows by half-spacing for hex packing
        let stagger: CGFloat = (row % 2 == 1 && colsInRow < maxPerRow) ? spacing * 0.5 : 0
        let outOffset = outwardDist + CGFloat(row) * rowDepthGap

        let proposed = CGPoint(
            x: parentPos.x + outOffset * outX + (perpOffset + stagger) * perpX,
            y: parentPos.y + outOffset * outY + (perpOffset + stagger) * perpY
        )

        let pos = resolveOverlap(
            proposed: proposed,
            nodeRadius: childSize / 2,
            existingNodes: nodes,
            gap: gap
        )

        nodes.append(TreeNode(
            id: item.id, kind: .skill(item), parentId: parentId,
            depth: depth, position: pos, radius: childSize / 2
        ))
        edges.append(EdgeLine(
            id: "edge-\(edgePrefix)-skill-\(idx)",
            fromId: parentId, toId: item.id, color: category.color
        ))
    }
}

// MARK: - Constellation View

struct ConstellationView: View {
    let identity: IdentityInfo?
    let skills: [SkillInfo]
    let workspaceFiles: [WorkspaceFileNode]
    /// Pre-computed skill-id → category map for O(1) lookups during view body evaluation.
    var categoryLookup: [String: SkillCategory] = [:]
    var onNavigateToSkill: ((String) -> Void)?
    var onNavigateToFile: ((String) -> Void)?
    @Binding var isFullscreen: Bool
    @State private var appearance = AvatarAppearanceManager.shared

    @State private var phase: AnimationPhase = .hidden
    @State private var panOffset: CGSize = .zero
    @State private var dragOffset: CGSize = .zero
    @State private var zoomScale: CGFloat = 1.0
    @State private var baseZoomScale: CGFloat = 1.0
    @State private var selectedPopoverItem: OrbitItem?
    @State private var selectedPopoverNodeId: String?
    @State private var popoverSize: CGSize = CGSize(width: 250, height: 120)
    @State private var zoomedNodeId: String?

    // Node sizes
    private let categoryNodeSize: CGFloat = 80
    private let skillNodeSize: CGFloat = 64
    private let customAvatarSize: CGFloat = 90
    private let nativeCharacterAvatarSize: CGFloat = 112
    private let subCatNodeSize: CGFloat = 56

    private var centerAvatarSize: CGFloat {
        hasCustomAvatar ? customAvatarSize : nativeCharacterAvatarSize
    }

    /// Tree layout positions, keyed by node ID.
    @State private var treePositions: [String: CGPoint] = [:]
    /// Tree nodes for rendering.
    @State private var treeNodes: [TreeNode] = []
    /// Tree edges for rendering.
    @State private var treeEdges: [EdgeLine] = []
    /// Per-node drag offsets keyed by node ID.
    @State private var nodeDragOffsets: [String: CGSize] = [:]
    /// Accumulated drag offset for the node currently being dragged.
    @State private var activeNodeDrag: (id: String, offset: CGSize)?


    private var existingFiles: [WorkspaceFileNode] {
        workspaceFiles.filter { $0.exists }
    }

    private var groups: [CategoryGroup] {
        let fileItems = existingFiles.enumerated().map { idx, node in
            // Detect files by the backend-provided path, not the display
            // label — labels are user-facing strings (e.g. "User Profile")
            // that no longer necessarily match the filename.
            let path: String? = node.path.hasSuffix(".md") ? node.path : nil
            return OrbitItem(
                id: "workspace-\(idx)", label: node.label, icon: SkillCategory.knowledge.icon,
                emoji: nil, color: SkillCategory.knowledge.color, filePath: path,
                description: nil, category: .knowledge, kind: .workspaceFile
            )
        }

        var buckets: [SkillCategory: [OrbitItem]] = [.knowledge: fileItems]
        for skill in skills {
            let cat = categoryLookup[skill.id] ?? .knowledge
            let item = OrbitItem(
                id: skill.id,
                label: skill.name,
                icon: cat.icon,
                emoji: skill.emoji,
                color: cat.color,
                filePath: nil,
                description: skill.description,
                category: cat
            )
            buckets[cat, default: []].append(item)
        }

        var result: [CategoryGroup] = []
        for cat in SkillCategory.allCases {
            if let items = buckets[cat], !items.isEmpty {
                result.append(CategoryGroup(category: cat, items: items))
            }
        }

        return result
    }

    /// Whether the user has uploaded a custom avatar image (vs. the bundled native character).
    /// Native characters set characterBodyShape/eyeStyle/color when saved, so if any
    /// component is present the avatar is a built character, not a custom upload.
    private var hasCustomAvatar: Bool {
        appearance.customAvatarImage != nil
    }

    /// Computes tree layout synchronously and populates all state vars.
    private func computeLayout(center: CGPoint) {
        let result = buildTree(center: center, groups: groups, centerSize: centerAvatarSize)
        treeNodes = result.nodes
        treeEdges = result.edges
        var positions: [String: CGPoint] = [:]
        for node in result.nodes {
            positions[node.id] = node.position
        }
        treePositions = positions
    }

    /// Recomputes layout and runs the staggered reveal animation.
    private func layoutAndAnimate(viewSize: CGSize) {
        let center = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)
        computeLayout(center: center)
        nodeDragOffsets.removeAll()
        activeNodeDrag = nil

        // Reset animation phase and stagger reveal
        phase = .hidden
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) {
                phase = .subCategories
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.7)) {
                phase = .complete
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            fitAll(viewSize: viewSize)
        }
    }

    /// Returns the effective position for a node, using tree positions + drag offset.
    private func effectivePosition(forId nodeId: String) -> CGPoint {
        let base = treePositions[nodeId] ?? .zero
        let stored = nodeDragOffsets[nodeId] ?? .zero
        let active = (activeNodeDrag?.id == nodeId) ? activeNodeDrag!.offset : .zero
        return CGPoint(
            x: base.x + (stored.width + active.width) / zoomScale,
            y: base.y + (stored.height + active.height) / zoomScale
        )
    }

    /// Zooms in and centers the viewport on a specific node.
    /// If already zoomed into the same node, zooms back out to fit all.
    private func zoomToNode(_ nodeId: String, viewSize: CGSize) {
        let targetZoom: CGFloat = 1.8

        // If already zoomed into this specific node, toggle back to fit-all
        if zoomedNodeId == nodeId {
            fitAll(viewSize: viewSize)
            return
        }

        // Compute position using targetZoom so the node ends up centered after zoom
        let base = treePositions[nodeId] ?? .zero
        let stored = nodeDragOffsets[nodeId] ?? .zero
        let nodePos = CGPoint(
            x: base.x + stored.width / targetZoom,
            y: base.y + stored.height / targetZoom
        )
        let center = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)

        // Pan so the node ends up at the viewport center
        let contentOffsetX = nodePos.x - center.x
        let contentOffsetY = nodePos.y - center.y

        withAnimation(.spring(response: 0.45, dampingFraction: 0.8)) {
            zoomScale = targetZoom
            baseZoomScale = targetZoom
            panOffset = CGSize(width: -contentOffsetX * targetZoom, height: -contentOffsetY * targetZoom)
            dragOffset = .zero
        }
        zoomedNodeId = nodeId
    }

    /// Computes zoom and pan to fit all nodes in the viewport with padding.
    private func fitAll(viewSize: CGSize) {
        zoomedNodeId = nil
        let center = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)

        if treePositions.isEmpty {
            computeLayout(center: center)
        }

        guard !treePositions.isEmpty else {
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

        for (_, pos) in treePositions {
            minX = min(minX, pos.x)
            maxX = max(maxX, pos.x)
            minY = min(minY, pos.y)
            maxY = max(maxY, pos.y)
        }

        let padding: CGFloat = 120
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

    /// Shared drag gesture for any draggable node.
    private func nodeDragGesture(nodeId: String) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                activeNodeDrag = (id: nodeId, offset: value.translation)
            }
            .onEnded { value in
                let prev = nodeDragOffsets[nodeId] ?? .zero
                nodeDragOffsets[nodeId] = CGSize(
                    width: prev.width + value.translation.width,
                    height: prev.height + value.translation.height
                )
                activeNodeDrag = nil
            }
    }

    /// Toggles the unified popover for a given item and node.
    private func togglePopover(item: OrbitItem, nodeId: String) {
        withAnimation(VAnimation.fast) {
            if selectedPopoverItem?.id == item.id {
                selectedPopoverItem = nil
                selectedPopoverNodeId = nil
            } else {
                selectedPopoverItem = item
                selectedPopoverNodeId = nodeId
            }
        }
    }

    /// Returns the appropriate "View Details" navigation action for a popover item,
    /// or nil if no deep-link is available for that item type.
    private func viewDetailsAction(for item: OrbitItem) -> (() -> Void)? {
        switch item.kind {
        case .skill:
            // Workspace file items stored as skills have filePath set — they don't deep-link to skill detail
            guard item.filePath == nil else { return nil }
            return {
                withAnimation(VAnimation.fast) {
                    selectedPopoverItem = nil
                    selectedPopoverNodeId = nil
                }
                onNavigateToSkill?(item.id)
            }
        case .workspaceFile:
            guard onNavigateToFile != nil else { return nil }
            return {
                withAnimation(VAnimation.fast) {
                    selectedPopoverItem = nil
                    selectedPopoverNodeId = nil
                }
                // Use filePath for files, fall back to label for directories (e.g. "skills/")
                let path = item.filePath ?? item.label
                onNavigateToFile?(path)
            }
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let totalOffset = CGSize(
                width: panOffset.width + dragOffset.width,
                height: panOffset.height + dragOffset.height
            )
            ZStack {
                // Static dotted grid (unaffected by zoom/pan)
                DottedGridBackground()
                    .allowsHitTesting(false)

                canvas(size: proxy.size)
                    .scaleEffect(zoomScale)
                    .offset(totalOffset)
            }
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()
                .contentShape(Rectangle())
                .overlay {
                    // Dismiss layer for popover
                    if selectedPopoverItem != nil {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture {
                                withAnimation(VAnimation.fast) {
                                    selectedPopoverItem = nil
                                    selectedPopoverNodeId = nil
                                }
                            }
                    }
                }
                .overlay {
                    // Popover overlay (outside clipped area so it doesn't get cut off)
                    if let popoverItem = selectedPopoverItem, let popoverNodeId = selectedPopoverNodeId {
                        let canvasCenter = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
                        let nodePos = effectivePosition(forId: popoverNodeId)
                        let viewCenter = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
                        let rawX = viewCenter.x + (nodePos.x - canvasCenter.x) * zoomScale + totalOffset.width
                        let rawY = viewCenter.y + (nodePos.y - canvasCenter.y) * zoomScale + totalOffset.height - 60

                        // Clamp so the popover stays within visible bounds
                        let margin: CGFloat = VSpacing.sm
                        let clampedX = min(max(rawX, popoverSize.width / 2 + margin), proxy.size.width - popoverSize.width / 2 - margin)
                        let clampedY = min(max(rawY, popoverSize.height / 2 + margin), proxy.size.height - popoverSize.height / 2 - margin)

                        NodePopoverView(
                            item: popoverItem,
                            onViewDetails: viewDetailsAction(for: popoverItem)
                        )
                        .onGeometryChange(for: CGSize.self) { proxy in
                            proxy.size
                        } action: { size in
                            popoverSize = size
                        }
                        .position(x: clampedX, y: clampedY)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
                }
                .overlay(alignment: .topLeading) {
                    fullscreenToggle
                        .padding(VSpacing.lg)
                }
                .overlay(alignment: .bottomLeading) {
                    shapeLegend
                        .padding(VSpacing.lg)
                        .opacity(phase.skillsVisible ? 1 : 0)
                        .animation(VAnimation.standard, value: phase)
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
                            zoomedNodeId = nil
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
                            zoomedNodeId = nil
                        }
                )
                .background {
                    ScrollWheelZoomHelper { delta in
                        let newScale = max(0.4, min(3.0, zoomScale * (1 + delta)))
                        withAnimation(VAnimation.snappy) {
                            zoomScale = newScale
                            baseZoomScale = newScale
                            zoomedNodeId = nil
                        }
                    }
                }
                .onAppear {
                    layoutAndAnimate(viewSize: proxy.size)
                }
                .onChange(of: skills.count) { _, _ in
                    layoutAndAnimate(viewSize: proxy.size)
                }
                #if os(macOS)
                .onKeyPress(.escape) {
                    if selectedPopoverItem != nil {
                        withAnimation(VAnimation.fast) {
                            selectedPopoverItem = nil
                            selectedPopoverNodeId = nil
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
        VButton(
            label: isFullscreen ? "Collapse" : "Expand",
            iconOnly: isFullscreen
                ? VIcon.minimize.rawValue
                : VIcon.maximize.rawValue,
            style: .ghost,
            tooltip: isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
        ) {
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                isFullscreen.toggle()
            }
        }
    }

    // MARK: - Shape Legend (bottom-left)

    private var shapeLegend: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            legendRow(shape: AnyView(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(VColor.contentTertiary, lineWidth: 2)
                    .frame(width: 14, height: 14)
            ), label: "Category")

            legendRow(shape: AnyView(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(VColor.contentTertiary, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2]))
                    .frame(width: 12, height: 12)
            ), label: "Subcategory")

            legendRow(shape: AnyView(
                RoundedRectangle(cornerRadius: 3)
                    .stroke(VColor.contentTertiary, lineWidth: 1.5)
                    .frame(width: 12, height: 12)
                    .rotationEffect(.degrees(45))
            ), label: "Skill")

            legendRow(shape: AnyView(
                Circle()
                    .stroke(VColor.contentTertiary, lineWidth: 1.5)
                    .frame(width: 12, height: 12)
            ), label: "Workspace")
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    private func legendRow(shape: AnyView, label: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            shape
                .frame(width: 16, height: 16)
            Text(label)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentSecondary)
        }
    }

    // MARK: - Viewport Controls (bottom-right)

    @ViewBuilder
    private func viewportControls(viewSize: CGSize) -> some View {
        HStack(spacing: VSpacing.xxs) {
            VButton(label: "Zoom in", iconOnly: VIcon.zoomIn.rawValue, style: .ghost, tooltip: "Zoom in") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    zoomScale = min(3.0, zoomScale + 0.25)
                    baseZoomScale = zoomScale
                }
                zoomedNodeId = nil
            }

            VButton(label: "Zoom out", iconOnly: VIcon.zoomOut.rawValue, style: .ghost, tooltip: "Zoom out") {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    zoomScale = max(0.4, zoomScale - 0.25)
                    baseZoomScale = zoomScale
                }
                zoomedNodeId = nil
            }

            VButton(label: "Fit all", iconOnly: VIcon.scan.rawValue, style: .ghost, tooltip: "Fit all skills") {
                fitAll(viewSize: viewSize)
            }
        }
    }

    // MARK: - Center Avatar

    @ViewBuilder
    private func centerAvatarView(showGlow: Bool) -> some View {
        VAvatarImage(image: appearance.fullAvatarImage, size: centerAvatarSize, showBorder: false)
            .if(showGlow) { view in
                view.background(
                    ZStack {
                        // Outer glow ring
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [
                                        VColor.primaryActive.opacity(0.25),
                                        VColor.primaryActive.opacity(0.08),
                                        Color.clear
                                    ],
                                    center: .center,
                                    startRadius: (centerAvatarSize + 16) / 2 - 4,
                                    endRadius: (centerAvatarSize + 16) / 2 + 12
                                )
                            )
                            .frame(width: centerAvatarSize + 40, height: centerAvatarSize + 40)

                        // Frosted backdrop
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [
                                        VColor.surfaceOverlay.opacity(0.95),
                                        VColor.surfaceOverlay.opacity(0.85)
                                    ],
                                    center: .center,
                                    startRadius: 0,
                                    endRadius: (centerAvatarSize + 16) / 2
                                )
                            )
                            .frame(width: centerAvatarSize + 16, height: centerAvatarSize + 16)

                        // Subtle inner ring
                        Circle()
                            .stroke(VColor.primaryActive.opacity(0.3), lineWidth: 1.5)
                            .frame(width: centerAvatarSize + 16, height: centerAvatarSize + 16)
                    }
                )
            }
            .allowsHitTesting(false)
            .position(effectivePosition(forId: "__center__"))
            .scaleEffect(phase.centerVisible ? 1 : 0.6)
            .opacity(phase.centerVisible ? 1 : 0)
            .animation(
                .spring(response: 0.5, dampingFraction: 0.7).delay(0.05),
                value: phase
            )
    }

    // MARK: - Canvas

    @ViewBuilder
    private func canvas(size: CGSize) -> some View {
        ZStack {
            // Background radial glow
            RadialGradient(
                colors: [VColor.primaryBase.opacity(0.06), Color.clear],
                center: .center,
                startRadius: 0,
                endRadius: min(size.width, size.height) * 0.5
            )

            // Edge lines (behind nodes)
            // Uses SwiftUI Path shapes instead of Canvas so edges are never clipped
            // to the view bounds — they extend as far as the nodes go.
            ForEach(treeEdges) { edge in
                Path { path in
                    let fromPos = effectivePosition(forId: edge.fromId)
                    let toPos = effectivePosition(forId: edge.toId)
                    path.move(to: fromPos)
                    path.addLine(to: toPos)
                }
                .stroke(edge.color.opacity(phase.categoriesVisible ? 0.45 : 0.0), lineWidth: 1.5)
                .allowsHitTesting(false)
            }
            .animation(.easeInOut(duration: 0.4), value: phase)

            // Tree nodes — each node is individually draggable.
            ForEach(Array(treeNodes.enumerated()), id: \.element.id) { idx, node in
                let nodeId = node.id
                let effPos = effectivePosition(forId: nodeId)

                switch node.kind {
                case .center:
                    EmptyView() // Center avatar is rendered separately

                case .category(let category):
                    CategoryNodeView(category: category, size: categoryNodeSize)
                        .onTapGesture(count: 2) { zoomToNode(nodeId, viewSize: size) }
                        .position(effPos)
                        .gesture(nodeDragGesture(nodeId: nodeId))
                        .scaleEffect(phase.categoriesVisible ? 1 : 0.3)
                        .opacity(phase.categoriesVisible ? 1 : 0)
                        .animation(
                            .spring(response: 0.45, dampingFraction: 0.7)
                                .delay(Double(idx) * 0.04),
                            value: phase
                        )

                case .subCategory(let label, let emoji, let category):
                    SubCategoryNodeView(label: label, emoji: emoji, category: category, size: subCatNodeSize)
                        .onTapGesture(count: 2) { zoomToNode(nodeId, viewSize: size) }
                        .position(effPos)
                        .gesture(nodeDragGesture(nodeId: nodeId))
                        .scaleEffect(phase.subCategoriesVisible ? 1 : 0.3)
                        .opacity(phase.subCategoriesVisible ? 1 : 0)
                        .animation(
                            .spring(response: 0.45, dampingFraction: 0.7)
                                .delay(Double(idx) * 0.03),
                            value: phase
                        )

                case .skill(let item):
                    SkillNodeView(
                        item: item,
                        size: skillNodeSize,
                        onDoubleTap: { zoomToNode(nodeId, viewSize: size) },
                        onTap: { togglePopover(item: item, nodeId: node.id) }
                    )
                    .position(effPos)
                    .gesture(nodeDragGesture(nodeId: nodeId))
                    .scaleEffect(phase.skillsVisible ? 1 : 0.4)
                    .opacity(phase.skillsVisible ? 1 : 0)
                    .animation(
                        .spring(response: 0.5, dampingFraction: 0.7)
                            .delay(0.08 + Double(idx) * 0.02),
                        value: phase
                    )

                }
            }

            // Center avatar on top of edges/nodes; glow only for custom uploads
            centerAvatarView(showGlow: hasCustomAvatar)
        }
    }
}

// MARK: - Dotted Grid Background

private struct DottedGridBackground: View {
    let spacing: CGFloat = 24
    let dotRadius: CGFloat = 1.5

    var body: some View {
        Canvas { context, size in
            let cols = Int(size.width / spacing) + 1
            let rows = Int(size.height / spacing) + 1
            for row in 0..<rows {
                for col in 0..<cols {
                    let x = CGFloat(col) * spacing
                    let y = CGFloat(row) * spacing
                    let rect = CGRect(
                        x: x - dotRadius,
                        y: y - dotRadius,
                        width: dotRadius * 2,
                        height: dotRadius * 2
                    )
                    context.fill(
                        Path(ellipseIn: rect),
                        with: .color(VColor.contentTertiary.opacity(0.2))
                    )
                }
            }
        }
    }
}

// MARK: - Scroll Wheel Zoom Helper

/// Transparent NSViewRepresentable that intercepts discrete mouse-wheel scroll
/// events over this view's bounds and converts them into zoom deltas.
/// Trackpad (precise) scrolling is left untouched for `MagnifyGesture`.
private struct ScrollWheelZoomHelper: NSViewRepresentable {
    var onZoomDelta: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onZoomDelta: onZoomDelta) }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let coordinator = context.coordinator
        coordinator.view = view
        coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak coordinator] event in
            guard let coordinator,
                  let v = coordinator.view,
                  let window = v.window,
                  event.window == window else { return event }
            let location = v.convert(event.locationInWindow, from: nil)
            guard v.bounds.width > 0, v.bounds.contains(location) else { return event }

            // Only handle discrete mouse-wheel scrolling.
            guard !event.hasPreciseScrollingDeltas else { return event }

            let delta = event.scrollingDeltaY / 10
            guard abs(delta) > 0.001 else { return event }

            coordinator.onZoomDelta(delta)
            return nil
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onZoomDelta = onZoomDelta
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        if let monitor = coordinator.monitor {
            NSEvent.removeMonitor(monitor)
            coordinator.monitor = nil
        }
    }

    class Coordinator {
        weak var view: NSView?
        var monitor: Any?
        var onZoomDelta: (CGFloat) -> Void

        init(onZoomDelta: @escaping (CGFloat) -> Void) {
            self.onZoomDelta = onZoomDelta
        }
    }
}
