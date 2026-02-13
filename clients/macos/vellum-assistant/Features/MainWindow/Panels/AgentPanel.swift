import SwiftUI

// MARK: - Pixel Border Shape

private struct PixelBorderShape: Shape {
    let pixelSize: CGFloat
    let cornerSteps: Int

    init(pixelSize: CGFloat = 3, cornerSteps: Int = 3) {
        self.pixelSize = pixelSize
        self.cornerSteps = cornerSteps
    }

    func path(in rect: CGRect) -> Path {
        let s = pixelSize
        let n = cornerSteps
        let W = rect.width
        let H = rect.height

        var path = Path()

        // Start at top edge after top-left corner
        path.move(to: CGPoint(x: CGFloat(n) * s, y: 0))

        // Top edge
        path.addLine(to: CGPoint(x: W - CGFloat(n) * s, y: 0))

        // Top-right corner (step right-down)
        for i in 0..<n {
            let fi = CGFloat(i)
            path.addLine(to: CGPoint(x: W - CGFloat(n - 1 - i) * s, y: fi * s))
            path.addLine(to: CGPoint(x: W - CGFloat(n - 1 - i) * s, y: (fi + 1) * s))
        }

        // Right edge
        path.addLine(to: CGPoint(x: W, y: H - CGFloat(n) * s))

        // Bottom-right corner (step down-left)
        for i in 0..<n {
            let fi = CGFloat(i)
            path.addLine(to: CGPoint(x: W - fi * s, y: H - CGFloat(n - 1 - i) * s))
            path.addLine(to: CGPoint(x: W - (fi + 1) * s, y: H - CGFloat(n - 1 - i) * s))
        }

        // Bottom edge
        path.addLine(to: CGPoint(x: CGFloat(n) * s, y: H))

        // Bottom-left corner (step left-up)
        for i in 0..<n {
            let fi = CGFloat(i)
            path.addLine(to: CGPoint(x: CGFloat(n - 1 - i) * s, y: H - fi * s))
            path.addLine(to: CGPoint(x: CGFloat(n - 1 - i) * s, y: H - (fi + 1) * s))
        }

        // Left edge
        path.addLine(to: CGPoint(x: 0, y: CGFloat(n) * s))

        // Top-left corner (step up-right)
        for i in 0..<n {
            let fi = CGFloat(i)
            path.addLine(to: CGPoint(x: fi * s, y: CGFloat(n - 1 - i) * s))
            path.addLine(to: CGPoint(x: (fi + 1) * s, y: CGFloat(n - 1 - i) * s))
        }

        path.closeSubpath()
        return path
    }
}

// MARK: - Agent Panel

struct AgentPanel: View {
    var onClose: () -> Void
    let daemonClient: DaemonClient

    @StateObject private var skillsManager: SkillsManager
    @State private var selectedTab = 0
    @State private var expandedSkillId: String?
    @State private var hoveredSkillButtonId: String?

    init(onClose: @escaping () -> Void, daemonClient: DaemonClient) {
        self.onClose = onClose
        self.daemonClient = daemonClient
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header (matches VSidePanel style)
            HStack {
                Text("AGENT")
                    .font(VFont.display)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Agent")
            }
            .padding(VSpacing.xl)

            // Tabbed navigation — pinned above scroll
            VSegmentedControl(
                items: ["Skills", "Available Skills", "Nodes", "Personality"],
                selection: $selectedTab
            )
            .padding(.horizontal, VSpacing.sm)

            Divider()
                .background(VColor.surfaceBorder)

            // Scrollable tab content
            ScrollView {
                Group {
                    switch selectedTab {
                    case 0:
                        skillsContent
                    case 1:
                        VEmptyState(
                            title: "No available skills",
                            subtitle: "Browse and add new skills",
                            icon: "plus.square.on.square"
                        )
                        .frame(height: 250)
                    case 2:
                        VEmptyState(
                            title: "No nodes",
                            subtitle: "Agent nodes will appear here",
                            icon: "point.3.connected.trianglepath.dotted"
                        )
                        .frame(height: 250)
                    case 3:
                        VEmptyState(
                            title: "Personality",
                            subtitle: "Configure agent personality here",
                            icon: "person.text.rectangle"
                        )
                        .frame(height: 250)
                    default:
                        EmptyView()
                    }
                }
                .padding(VSpacing.xl)
            }
        }
        .background(VColor.backgroundSubtle)
        .onAppear {
            skillsManager.fetchSkills()
        }
    }

    // MARK: - Skills Tab

    @ViewBuilder
    private var skillsContent: some View {
        if skillsManager.isLoading {
            HStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Spacer()
            }
            .frame(height: 250)
        } else if skillsManager.skills.isEmpty {
            VEmptyState(
                title: "No skills",
                subtitle: "Agent skills will appear here",
                icon: "bolt.fill"
            )
            .frame(height: 250)
        } else {
            VStack(spacing: VSpacing.md) {
                ForEach(skillsManager.skills) { skill in
                    skillCard(skill)
                }
            }
        }
    }

    private func skillCard(_ skill: SkillSummaryItem) -> some View {
        let isExpanded = expandedSkillId == skill.id
        let isHovered = hoveredSkillButtonId == skill.id
        let borderColor = isHovered ? Amber._600.opacity(0.8) : Amber._700.opacity(0.6)

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: VSpacing.md) {
                // Pixel-bordered button to use the skill
                Button(action: {
                    // TODO: implement skill usage
                }) {
                    HStack(spacing: VSpacing.md) {
                        skillIcon(skill.icon)

                        Text(skill.name)
                            .font(VFont.mono)
                            .foregroundColor(VColor.textPrimary)
                    }
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
                    .background(isHovered ? Slate._700 : Slate._900)
                    .clipShape(PixelBorderShape())
                    .overlay(
                        PixelBorderShape()
                            .stroke(borderColor, lineWidth: 2.5)
                    )
                    .contentShape(PixelBorderShape())
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    withAnimation(VAnimation.fast) {
                        hoveredSkillButtonId = hovering ? skill.id : nil
                    }
                }

                Spacer()

                // View button — expands skill details
                VButton(label: isExpanded ? "Hide" : "View", style: .ghost) {
                    withAnimation(VAnimation.standard) {
                        if isExpanded {
                            expandedSkillId = nil
                        } else {
                            expandedSkillId = skill.id
                            skillsManager.fetchSkillBody(skillId: skill.id)
                        }
                    }
                }
            }

            // Expanded body
            if isExpanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        // Summary (description)
                        Text(skill.description)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)

                        // Full body content
                        skillBody(for: skill.id)
                    }
                    .padding(VSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 300)
                .background(Slate._900)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
                .padding(.top, VSpacing.md)
            }
        }
    }

    @ViewBuilder
    private func skillBody(for skillId: String) -> some View {
        if let body = skillsManager.loadedBodies[skillId] {
            Text(body)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .textSelection(.enabled)
        } else {
            ProgressView()
                .controlSize(.small)
                .padding(.vertical, VSpacing.sm)
        }
    }

    @ViewBuilder
    private func skillIcon(_ svgString: String?) -> some View {
        if let svgString,
           let data = svgString.data(using: .utf8),
           let nsImage = NSImage(data: data) {
            Image(nsImage: nsImage)
                .resizable()
                .interpolation(.none)
                .frame(width: 24, height: 24)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
        } else {
            Image(systemName: "bolt.fill")
                .font(.system(size: 13))
                .foregroundColor(VColor.textMuted)
                .frame(width: 24, height: 24)
        }
    }
}

#Preview {
    AgentPanel(onClose: {}, daemonClient: DaemonClient())
}
