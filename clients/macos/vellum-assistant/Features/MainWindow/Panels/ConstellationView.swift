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

    var color: Color {
        switch self {
        case .core: return Amber._400
        case .devTools: return Sage._400
        case .communication: return Sage._400
        case .daily: return Emerald._400
        case .utilities: return Stone._400
        case .skills: return Rose._400
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
    let id: String // stable key for offset tracking
    let label: String
    let icon: String
    let emoji: String?
    let color: Color
    let filePath: String? // non-nil for workspace .md files
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
                    context.fill(Circle().path(in: rect), with: .color(Slate._500.opacity(0.4)))
                }
            }
        }
    }
}

// MARK: - Branch Shape

private struct BranchShape: Shape {
    let from: CGPoint
    let to: CGPoint

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: from)

        let dx = to.x - from.x
        let dy = to.y - from.y
        let mid = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
        let offset: CGFloat = 12
        let length = sqrt(dx * dx + dy * dy)
        guard length > 0 else { return path }
        let nx = -dy / length * offset
        let ny = dx / length * offset
        let control = CGPoint(x: mid.x + nx, y: mid.y + ny)

        path.addQuadCurve(to: to, control: control)
        return path
    }
}

// MARK: - Category Hub Label

private struct CategoryHubLabel: View {
    let category: SkillCategory
    let itemCount: Int
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: category.icon)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(category.color)

            Text(category.displayName)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule()
                .fill(category.color.opacity(isHovered ? 0.14 : 0.08))
                .overlay(
                    Capsule()
                        .stroke(category.color.opacity(isHovered ? 0.35 : 0.2), lineWidth: 0.5)
                )
        )
        .onHover { hovering in
            withAnimation(.easeInOut(duration: 0.15)) {
                isHovered = hovering
            }
        }
    }
}

// MARK: - Draggable Node Wrapper

private struct DraggableNode<Content: View>: View {
    let nodeKey: String
    /// Additional node keys that move together with this node (e.g. child leaves of a hub).
    var childKeys: [String] = []
    @Binding var offsets: [String: CGSize]
    @ViewBuilder let content: () -> Content

    @State private var dragStartOffset: CGSize?
    @State private var childStartOffsets: [String: CGSize] = [:]

    var body: some View {
        content()
            .offset(offsets[nodeKey] ?? .zero)
            .highPriorityGesture(
                DragGesture()
                    .onChanged { value in
                        if dragStartOffset == nil {
                            dragStartOffset = offsets[nodeKey] ?? .zero
                            for key in childKeys {
                                childStartOffsets[key] = offsets[key] ?? .zero
                            }
                        }
                        let start = dragStartOffset ?? .zero
                        offsets[nodeKey] = CGSize(
                            width: start.width + value.translation.width,
                            height: start.height + value.translation.height
                        )
                        for key in childKeys {
                            let childStart = childStartOffsets[key] ?? .zero
                            offsets[key] = CGSize(
                                width: childStart.width + value.translation.width,
                                height: childStart.height + value.translation.height
                            )
                        }
                    }
                    .onEnded { _ in
                        dragStartOffset = nil
                        childStartOffsets.removeAll()
                    }
            )
    }
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
    @State private var nodeOffsets: [String: CGSize] = [:]
    @State private var zoomScale: CGFloat = 1.0
    @State private var baseZoomScale: CGFloat = 1.0

    private var existingFiles: [WorkspaceFileNode] {
        workspaceFiles.filter { $0.exists }
    }

    private var groups: [CategoryGroup] {
        let fileItems = existingFiles.enumerated().map { idx, node in
            let path: String? = node.label.hasSuffix(".md") ? node.path : nil
            return OrbitItem(id: "core-\(idx)", label: node.label, icon: "doc.text.fill", emoji: nil, color: Amber._400, filePath: path)
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

    // MARK: - Effective position (base + user offset)

    private func effectivePos(_ base: CGPoint, key: String) -> CGPoint {
        let off = nodeOffsets[key] ?? .zero
        return CGPoint(x: base.x + off.width, y: base.y + off.height)
    }

    // MARK: - Canvas

    @ViewBuilder
    private func canvas(size: CGSize) -> some View {
        // Shift center down so upper nodes aren't clipped by the panel header
        let center = CGPoint(x: size.width / 2, y: size.height * 0.55)
        let hubRadius: CGFloat = 160
        let leafRadius: CGFloat = 110
        let layoutGroups = groups
        let hubBasePositions = computeHubPositions(
            center: center, radius: hubRadius, count: layoutGroups.count
        )

        ZStack {
            // Background glow
            RadialGradient(
                colors: [Sage._600.opacity(0.06), Color.clear],
                center: .center,
                startRadius: 0,
                endRadius: min(size.width, size.height) * 0.5
            )

            canvasBranches(center: center, hubBasePositions: hubBasePositions, leafRadius: leafRadius, layoutGroups: layoutGroups)
            canvasHubs(hubBasePositions: hubBasePositions, layoutGroups: layoutGroups)
            canvasLeaves(center: center, hubBasePositions: hubBasePositions, leafRadius: leafRadius, layoutGroups: layoutGroups)

            // Center dino face — non-interactive so drags pass to canvas pan
            DinoFaceView(seed: identity?.name ?? "default", palette: appearance.palette, outfit: appearance.outfit)
                .frame(width: 80, height: 80)
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

    @ViewBuilder
    private func canvasBranches(center: CGPoint, hubBasePositions: [CGPoint], leafRadius: CGFloat, layoutGroups: [CategoryGroup]) -> some View {
        // Center → hub branches
        ForEach(Array(layoutGroups.enumerated()), id: \.element.id) { groupIdx, group in
            let hubKey = "hub-\(group.category.rawValue)"
            let hubPos = effectivePos(hubBasePositions[groupIdx], key: hubKey)
            BranchShape(from: center, to: hubPos)
                .stroke(group.category.color.opacity(0.25), lineWidth: 1.5)
                .opacity(phase.hubBranchesVisible ? 1 : 0)
                .animation(
                    .easeIn(duration: 0.3).delay(0.20 + Double(groupIdx) * 0.04),
                    value: phase
                )
        }

        // Hub → leaf branches
        ForEach(Array(layoutGroups.enumerated()), id: \.element.id) { groupIdx, group in
            let hubKey = "hub-\(group.category.rawValue)"
            let hubPos = effectivePos(hubBasePositions[groupIdx], key: hubKey)
            let leafBasePositions = computeLeafPositions(
                hub: hubBasePositions[groupIdx], center: center, radius: leafRadius,
                count: group.items.count
            )

            ForEach(Array(group.items.enumerated()), id: \.element.id) { leafIdx, item in
                let leafPos = effectivePos(leafBasePositions[leafIdx], key: item.id)
                BranchShape(from: hubPos, to: leafPos)
                    .stroke(group.category.color.opacity(0.18), lineWidth: 1)
                    .opacity(phase.leafBranchesVisible ? 1 : 0)
                    .animation(
                        .easeIn(duration: 0.25).delay(0.35 + Double(groupIdx) * 0.04 + Double(leafIdx) * 0.03),
                        value: phase
                    )
            }
        }
    }

    @ViewBuilder
    private func canvasHubs(hubBasePositions: [CGPoint], layoutGroups: [CategoryGroup]) -> some View {
        ForEach(Array(layoutGroups.enumerated()), id: \.element.id) { groupIdx, group in
            let hubKey = "hub-\(group.category.rawValue)"
            let leafKeys = group.items.map(\.id)
            DraggableNode(nodeKey: hubKey, childKeys: leafKeys, offsets: $nodeOffsets) {
                CategoryHubLabel(category: group.category, itemCount: group.items.count)
            }
            .position(hubBasePositions[groupIdx])
            .scaleEffect(phase.hubsVisible ? 1 : 0.3)
            .opacity(phase.hubsVisible ? 1 : 0)
            .animation(
                .spring(response: 0.45, dampingFraction: 0.7)
                    .delay(0.12 + Double(groupIdx) * 0.05),
                value: phase
            )
        }
    }

    @ViewBuilder
    private func canvasLeaves(center: CGPoint, hubBasePositions: [CGPoint], leafRadius: CGFloat, layoutGroups: [CategoryGroup]) -> some View {
        ForEach(Array(layoutGroups.enumerated()), id: \.element.id) { groupIdx, group in
            canvasLeafGroup(
                groupIdx: groupIdx, group: group, center: center,
                hubPosition: hubBasePositions[groupIdx], leafRadius: leafRadius
            )
        }
    }

    @ViewBuilder
    private func canvasLeafGroup(groupIdx: Int, group: CategoryGroup, center: CGPoint, hubPosition: CGPoint, leafRadius: CGFloat) -> some View {
        let leafBasePositions = computeLeafPositions(
            hub: hubPosition, center: center, radius: leafRadius,
            count: group.items.count
        )

        ForEach(Array(group.items.enumerated()), id: \.element.id) { leafIdx, item in
            DraggableNode(nodeKey: item.id, offsets: $nodeOffsets) {
                ConstellationPill(
                    label: item.label, icon: item.icon,
                    emoji: item.emoji, color: item.color,
                    onTap: item.filePath.map { path in
                        { onFileSelected?(path) }
                    }
                )
            }
            .position(leafBasePositions[leafIdx])
            .scaleEffect(phase.leavesVisible ? 1 : 0.4)
            .opacity(phase.leavesVisible ? 1 : 0)
            .animation(
                .spring(response: 0.5, dampingFraction: 0.7)
                    .delay(0.25 + Double(groupIdx) * 0.06 + Double(leafIdx) * 0.04),
                value: phase
            )
        }
    }

    // MARK: - Layout

    private func computeHubPositions(center: CGPoint, radius: CGFloat, count: Int) -> [CGPoint] {
        guard count > 0 else { return [] }
        if count == 1 {
            return [CGPoint(x: center.x, y: center.y - radius)]
        }
        return (0..<count).map { i in
            let angle = (2 * .pi * Double(i) / Double(count)) - .pi / 2
            return CGPoint(
                x: center.x + radius * CGFloat(Darwin.cos(angle)),
                y: center.y + radius * CGFloat(Darwin.sin(angle))
            )
        }
    }

    private func computeLeafPositions(
        hub: CGPoint, center: CGPoint, radius: CGFloat, count: Int
    ) -> [CGPoint] {
        guard count > 0 else { return [] }

        let dx = hub.x - center.x
        let dy = hub.y - center.y
        let baseAngle = atan2(dy, dx)

        if count == 1 {
            return [CGPoint(
                x: hub.x + radius * CGFloat(Darwin.cos(baseAngle)),
                y: hub.y + radius * CGFloat(Darwin.sin(baseAngle))
            )]
        }

        let maxArc: Double = 2 * .pi / 3
        let arc = min(maxArc, Double(count - 1) * (.pi / 5))
        let startAngle = baseAngle - arc / 2

        return (0..<count).map { i in
            let fraction = Double(i) / Double(count - 1)
            let angle = startAngle + arc * fraction
            return CGPoint(
                x: hub.x + radius * CGFloat(Darwin.cos(angle)),
                y: hub.y + radius * CGFloat(Darwin.sin(angle))
            )
        }
    }
}

// MARK: - Animation Phase

private enum AnimationPhase: Equatable {
    case hidden
    case complete

    var centerVisible: Bool { self == .complete }
    var hubsVisible: Bool { self == .complete }
    var hubBranchesVisible: Bool { self == .complete }
    var leavesVisible: Bool { self == .complete }
    var leafBranchesVisible: Bool { self == .complete }
}

// MARK: - Polished Pill

private struct ConstellationPill: View {
    let label: String
    let icon: String
    let emoji: String?
    let color: Color
    var onTap: (() -> Void)?

    @State private var isHovered = false

    private var isTappable: Bool { onTap != nil }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
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
            }
        }
        #endif
        .onTapGesture {
            onTap?()
        }
    }
}
