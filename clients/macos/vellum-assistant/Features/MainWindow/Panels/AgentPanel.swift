import SwiftUI

// MARK: - Pixel Border Shape

struct PixelBorderShape: Shape {
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
    @State private var selectedSkillSlug: String?
    @State private var hoveredDetailInstall = false

    init(onClose: @escaping () -> Void, daemonClient: DaemonClient) {
        self.onClose = onClose
        self.daemonClient = daemonClient
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
    }

    var body: some View {
        VSidePanel(title: "Agent", onClose: onClose, pinnedContent: {
            VSegmentedControl(
                items: ["Skills", "Available Skills", "Nodes", "Personality"],
                selection: $selectedTab
            )
            .padding(.top, VSpacing.sm)

            Divider().background(VColor.surfaceBorder)
        }) {
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
            emoji: "\u{1F305}"
        )
    }

    /// ClaWHub skills filtered to exclude already-installed ones, with local search and sort.
    private var availableClawhubSkills: [ClawhubSkillItem] {
        let installedNames = Set(skillsManager.skills.map(\.name))
        var filtered = skillsManager.searchResults
            .filter { !installedNames.contains($0.name) }

        // Local fuzzy filter by name/description
        if !skillSearchQuery.isEmpty {
            let query = skillSearchQuery.lowercased()
            filtered = filtered.filter {
                $0.name.lowercased().contains(query) ||
                $0.description.lowercased().contains(query) ||
                $0.slug.lowercased().contains(query)
            }
        }

        switch skillSortOrder {
        case .installs:
            return filtered.sorted { $0.installs > $1.installs }
        case .stars:
            return filtered.sorted { $0.stars > $1.stars }
        case .newest:
            return filtered.sorted { $0.createdAt > $1.createdAt }
        }
    }

    @ViewBuilder
    private var availableSkillsContent: some View {
        Group {
            if let slug = selectedSkillSlug,
               let searchItem = skillsManager.searchResults.first(where: { $0.slug == slug }) {
                skillDetailView(slug: slug, searchItem: searchItem)
            } else {
                availableSkillsList
            }
        }
        .onChange(of: skillsManager.installResult?.slug) {
            if let result = skillsManager.installResult {
                if result.slug == installingSlug {
                    installingSlug = nil
                }
            }
        }
    }

    @ViewBuilder
    private var availableSkillsList: some View {
        VStack(spacing: VSpacing.lg) {
            // Bundled skills — always shown as featured
            ForEach(BundledSkill.all) { starter in
                bundledSkillCard(starter)
            }

            // Search bar — filters locally, no API call
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundColor(VColor.textMuted)

                TextField("Filter skills...", text: $skillSearchQuery)
                    .textFieldStyle(.plain)
                    .font(VFont.mono)
                    .foregroundColor(VColor.textPrimary)

                if !skillSearchQuery.isEmpty {
                    Button(action: { skillSearchQuery = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(VSpacing.md)
            .background(Slate._800)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

            // Sort picker
            HStack(spacing: VSpacing.sm) {
                Text("Sort:")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)

                ForEach(SkillSortOrder.allCases, id: \.self) { order in
                    Button(action: { skillSortOrder = order }) {
                        Text(order.rawValue)
                            .font(VFont.caption)
                            .foregroundColor(skillSortOrder == order ? Emerald._400 : VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .background(skillSortOrder == order ? Emerald._400.opacity(0.15) : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                    .buttonStyle(.plain)
                }

                Spacer()
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
            } else if !skillSearchQuery.isEmpty {
                VEmptyState(
                    title: "No results",
                    subtitle: "No skills matched \"\(skillSearchQuery)\"",
                    icon: "magnifyingglass"
                )
                .frame(height: 100)
            }

            // Community disclaimer
            VStack(spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .font(.system(size: 10))
                        .foregroundColor(Amber._500)
                    Text("Community skills are not verified by Vellum. Review before installing.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 10))
                        .foregroundColor(Emerald._400)
                    Text("Browse more on ClawhHub")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .onAppear {
            skillsManager.searchSkills()
        }
    }

    @State private var installingSlug: String?
    @State private var hoveredStarterInstall: String?
    @State private var skillSearchQuery = ""
    @State private var skillSortOrder: SkillSortOrder = .installs

    private enum SkillSortOrder: String, CaseIterable {
        case installs = "Installs"
        case stars = "Stars"
        case newest = "Newest"
    }

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

    /// How long ago a skill was published, as a human-readable string.
    private func skillAge(_ createdAt: Int) -> String {
        guard createdAt > 0 else { return "" }
        let date = Date(timeIntervalSince1970: Double(createdAt) / 1000)
        let days = Int(Date().timeIntervalSince(date) / 86400)
        if days < 1 { return "today" }
        if days == 1 { return "1 day ago" }
        if days < 30 { return "\(days) days ago" }
        let months = days / 30
        if months == 1 { return "1 month ago" }
        return "\(months) months ago"
    }

    private func clawhubSkillCard(_ skill: ClawhubSkillItem) -> some View {
        let isInstalling = installingSlug == skill.slug
        let isHovered = hoveredStarterInstall == skill.slug
        let isNew = skill.createdAt > 0 && Date().timeIntervalSince(
            Date(timeIntervalSince1970: Double(skill.createdAt) / 1000)
        ) < 7 * 86400

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.md) {
                // Tappable area: icon + name + description
                HStack(spacing: VSpacing.md) {
                    Image(systemName: "shippingbox.fill")
                        .font(.system(size: 16))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 24)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: VSpacing.sm) {
                            Text(skill.name)
                                .font(VFont.mono)
                                .foregroundColor(VColor.textPrimary)

                            if isNew {
                                Text("NEW")
                                    .font(VFont.small)
                                    .foregroundColor(Amber._500)
                            }
                        }

                        Text(skill.description)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .lineLimit(2)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(VAnimation.standard) {
                        selectedSkillSlug = skill.slug
                        skillsManager.inspectSkill(slug: skill.slug)
                    }
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

            // Trust signals row
            HStack(spacing: VSpacing.lg) {
                if !skill.author.isEmpty {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "person.fill")
                            .font(.system(size: 9))
                        Text(skill.author)
                    }
                }

                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 9))
                    Text("\(skill.stars)")
                }

                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 9))
                    Text("\(skill.installs)")
                }

                if !skillAge(skill.createdAt).isEmpty {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "clock")
                            .font(.system(size: 9))
                        Text(skillAge(skill.createdAt))
                    }
                }
            }
            .font(VFont.small)
            .foregroundColor(VColor.textMuted)
            .padding(.leading, 24 + VSpacing.md)
        }
        .padding(VSpacing.lg)
        .background(Slate._900)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isNew ? Amber._700.opacity(0.4) : Emerald._700.opacity(0.4), lineWidth: 1)
        )
    }

    // MARK: - Skill Detail View

    @ViewBuilder
    private func skillDetailView(slug: String, searchItem: ClawhubSkillItem) -> some View {
        let isNew = searchItem.createdAt > 0 && Date().timeIntervalSince(
            Date(timeIntervalSince1970: Double(searchItem.createdAt) / 1000)
        ) < 7 * 86400

        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Back button
            Button(action: {
                withAnimation(VAnimation.standard) {
                    selectedSkillSlug = nil
                    skillsManager.clearInspection()
                }
            }) {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Available Skills")
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)

            // Title row — always visible from search data
            HStack(spacing: VSpacing.sm) {
                Text(skillsManager.inspectedSkill?.skill.displayName ?? searchItem.name)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)

                if isNew {
                    Text("NEW")
                        .font(VFont.small)
                        .foregroundColor(Amber._500)
                }
            }

            // Author row — use inspect owner if available, fall back to search author
            if let owner = skillsManager.inspectedSkill?.owner {
                HStack(spacing: VSpacing.sm) {
                    if let imageURL = owner.image, let url = URL(string: imageURL) {
                        AsyncImage(url: url) { image in
                            image.resizable().aspectRatio(contentMode: .fill)
                        } placeholder: {
                            Image(systemName: "person.circle.fill")
                                .foregroundColor(VColor.textMuted)
                        }
                        .frame(width: 20, height: 20)
                        .clipShape(Circle())
                    } else {
                        Image(systemName: "person.circle.fill")
                            .font(.system(size: 16))
                            .foregroundColor(VColor.textMuted)
                    }
                    Text(owner.displayName.isEmpty ? owner.handle : owner.displayName)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if !searchItem.author.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "person.fill")
                        .font(.system(size: 12))
                        .foregroundColor(VColor.textMuted)
                    Text(searchItem.author)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            // Summary — use inspect summary if available, fall back to search description
            let summary = skillsManager.inspectedSkill?.skill.summary ?? ""
            let description = summary.isEmpty ? searchItem.description : summary
            if !description.isEmpty {
                Text(description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Stats row — use inspect stats if available, fall back to search data
            if let stats = skillsManager.inspectedSkill?.stats {
                HStack(spacing: VSpacing.lg) {
                    statItem(icon: "star.fill", value: "\(stats.stars)")
                    statItem(icon: "arrow.down.circle", value: "\(stats.installs)")
                    statItem(icon: "arrow.down.to.line", value: "\(stats.downloads)")
                    if stats.versions > 0 {
                        statItem(icon: "tag", value: "\(stats.versions) versions")
                    }
                    if !skillAge(searchItem.createdAt).isEmpty {
                        statItem(icon: "clock", value: skillAge(searchItem.createdAt))
                    }
                }
            } else {
                // Baseline stats from search results
                HStack(spacing: VSpacing.lg) {
                    statItem(icon: "star.fill", value: "\(searchItem.stars)")
                    statItem(icon: "arrow.down.circle", value: "\(searchItem.installs)")
                    if !skillAge(searchItem.createdAt).isEmpty {
                        statItem(icon: "clock", value: skillAge(searchItem.createdAt))
                    }
                }
            }

            // Inspect-only content (loading, error, or enriched details)
            if skillsManager.isInspecting {
                HStack {
                    Spacer()
                    VStack(spacing: VSpacing.md) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading more details...")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                    }
                    Spacer()
                }
                .frame(height: 80)
            } else if let error = skillsManager.inspectError {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(Amber._500)
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            } else if let data = skillsManager.inspectedSkill {
                // Enriched content from inspect (version, README, files)
                skillDetailEnrichedContent(data)
            }

            // Install button — always visible
            detailInstallButton(slug: slug)
        }
    }

    /// Enriched content from inspect API — version, README, files.
    /// Title, author, summary, and stats are handled by the parent `skillDetailView`.
    @ViewBuilder
    private func skillDetailEnrichedContent(_ data: ClawhubInspectData) -> some View {
        // Latest version
        if let version = data.latestVersion {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("v\(version.version)")
                    .font(VFont.mono)
                    .foregroundColor(Emerald._400)
                if let changelog = version.changelog, !changelog.isEmpty {
                    Text(changelog)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Slate._900)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }

        // SKILL.md content
        if let md = data.skillMdContent, !md.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("README")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textMuted)

                ScrollView {
                    Text(md)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textSecondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(VSpacing.md)
                }
                .frame(maxHeight: 250)
                .background(Slate._900)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
            }
        }

        // Files list
        if let files = data.files, !files.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Files")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)

                ForEach(files, id: \.path) { file in
                    HStack {
                        Image(systemName: "doc.text")
                            .font(.system(size: 10))
                            .foregroundColor(VColor.textMuted)
                        Text(file.path)
                            .font(VFont.monoSmall)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                        Text(formatFileSize(file.size))
                            .font(VFont.small)
                            .foregroundColor(VColor.textMuted)
                    }
                }
            }
        }
    }

    private func statItem(icon: String, value: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: icon)
                .font(.system(size: 9))
            Text(value)
        }
        .font(VFont.small)
        .foregroundColor(VColor.textMuted)
    }

    private func formatFileSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        return String(format: "%.1f MB", kb / 1024)
    }

    @ViewBuilder
    private func detailInstallButton(slug: String) -> some View {
        let isInstalling = installingSlug == slug
        let result = skillsManager.installResult
        let isSuccess = result?.slug == slug && result?.success == true
        let isError = result?.slug == slug && result?.success == false
        let errorMessage = result?.error

        Button(action: {
            guard installingSlug == nil, !isSuccess else { return }
            installingSlug = slug
            skillsManager.installSkill(slug: slug)
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                if installingSlug == slug {
                    installingSlug = nil
                }
            }
        }) {
            HStack(spacing: VSpacing.sm) {
                if isSuccess {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14))
                    Text("Installed!")
                } else if isInstalling {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Installing...")
                } else {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.system(size: 14))
                    Text("Install")
                }
            }
            .font(VFont.mono)
            .frame(maxWidth: .infinity)
            .padding(.vertical, VSpacing.md)
            .foregroundColor(isSuccess ? Emerald._400 : (hoveredDetailInstall && !isInstalling ? Slate._900 : Emerald._400))
            .background(isSuccess ? Emerald._400.opacity(0.15) : (hoveredDetailInstall && !isInstalling ? Emerald._400 : Slate._800))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSuccess ? Emerald._500 : Emerald._500.opacity(0.6), lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
        .disabled(isInstalling || isSuccess)
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredDetailInstall = hovering
            }
        }

        // Error message
        if isError, let msg = errorMessage {
            Text(msg)
                .font(VFont.caption)
                .foregroundColor(Rose._500)
        }
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
