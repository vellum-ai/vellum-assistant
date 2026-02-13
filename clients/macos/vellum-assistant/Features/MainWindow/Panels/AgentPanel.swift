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
                    .font(VFont.panelTitle)
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
                        availableSkillsContent
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

    // MARK: - Available Skills Tab

    /// Bundled starter skills shown as featured in the Available Skills tab.
    private struct BundledSkill: Identifiable {
        var id: String { slug }
        let slug: String
        let name: String
        let description: String
        let emoji: String

        static let all: [BundledSkill] = [startTheDay]

        static let startTheDay = BundledSkill(
            slug: "start-the-day",
            name: "Start the Day",
            description: "Get a personalized daily briefing with weather, news, and actionable insights",
            emoji: "🌅"
        )
    }

    /// ClaWHub skills filtered to exclude already-installed ones.
    private var availableClawhubSkills: [ClawhubSkillItem] {
        let installedNames = Set(skillsManager.skills.map(\.name))
        return skillsManager.searchResults.filter { !installedNames.contains($0.name) }
    }

    @ViewBuilder
    private var availableSkillsContent: some View {
        VStack(spacing: VSpacing.lg) {
            // Bundled skills — always shown as featured
            ForEach(BundledSkill.all) { starter in
                bundledSkillCard(starter)
            }

            // ClaWHub skills
            if skillsManager.isSearching {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                .frame(height: 60)
            } else if !availableClawhubSkills.isEmpty {
                ForEach(availableClawhubSkills) { skill in
                    clawhubSkillCard(skill)
                }
            }

            // Browse more nudge
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "sparkles")
                    .font(.system(size: 10))
                    .foregroundColor(Emerald._400)
                Text("Browse more community skills on ClawhHub")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
        }
        .onAppear {
            skillsManager.searchSkills()
        }
    }

    @State private var installingSlug: String?
    @State private var hoveredStarterInstall: String?

    private func bundledSkillCard(_ starter: BundledSkill) -> some View {
        HStack(spacing: VSpacing.md) {
            Text(starter.emoji)
                .font(.system(size: 20))

            VStack(alignment: .leading, spacing: 2) {
                Text(starter.name)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)

                Text(starter.description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineLimit(2)
            }

            Spacer()

            Text("Included")
                .font(VFont.caption)
                .foregroundColor(Emerald._400)
        }
        .padding(VSpacing.lg)
        .background(Slate._900)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(Emerald._700.opacity(0.4), lineWidth: 1)
        )
    }

    private func clawhubSkillCard(_ skill: ClawhubSkillItem) -> some View {
        let isInstalling = installingSlug == skill.slug
        let isHovered = hoveredStarterInstall == skill.slug

        return HStack(spacing: VSpacing.md) {
            Image(systemName: "shippingbox.fill")
                .font(.system(size: 16))
                .foregroundColor(VColor.textMuted)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)

                Text(skill.description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineLimit(2)
            }

            Spacer()

            Button(action: {
                guard installingSlug == nil else { return }
                installingSlug = skill.slug
                skillsManager.installSkill(slug: skill.slug)
                DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                    if installingSlug == skill.slug {
                        installingSlug = nil
                    }
                }
            }) {
                HStack(spacing: VSpacing.sm) {
                    if isInstalling {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.system(size: 12))
                    }
                    Text(isInstalling ? "Installing..." : "Install")
                        .font(VFont.mono)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
                .foregroundColor(isHovered ? Slate._900 : Emerald._400)
                .background(isHovered ? Emerald._400 : Slate._800)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(Emerald._500.opacity(0.6), lineWidth: 1.5)
                )
            }
            .buttonStyle(.plain)
            .disabled(installingSlug != nil)
            .onHover { hovering in
                withAnimation(VAnimation.fast) {
                    hoveredStarterInstall = hovering ? skill.slug : nil
                }
            }
        }
        .padding(VSpacing.lg)
        .background(Slate._900)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(Emerald._700.opacity(0.4), lineWidth: 1)
        )
    }

    // MARK: - Skills Tab

    /// Names of bundled starter skills featured in Available Skills (hidden from Skills tab).
    private static let featuredBundledNames: Set<String> = Set(
        BundledSkill.all.map(\.name)
    )

    /// Skills to show in the Skills tab (excludes bundled starters featured in Available Skills).
    private var userSkills: [SkillInfo] {
        skillsManager.skills.filter { !Self.featuredBundledNames.contains($0.name) }
    }

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
        } else if userSkills.isEmpty {
            VEmptyState(
                title: "No skills",
                subtitle: "Agent skills will appear here",
                icon: "bolt.fill"
            )
            .frame(height: 250)
        } else {
            VStack(spacing: VSpacing.md) {
                ForEach(userSkills) { skill in
                    skillCard(skill)
                }
            }
        }
    }

    private func skillCard(_ skill: SkillInfo) -> some View {
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
                        skillIcon(skill.emoji)

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
    private func skillIcon(_ emoji: String?) -> some View {
        if let emoji, !emoji.isEmpty {
            Text(emoji)
                .font(.system(size: 20))
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
