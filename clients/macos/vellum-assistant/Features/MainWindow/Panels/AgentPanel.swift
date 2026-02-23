import SwiftUI
import VellumAssistantShared

// MARK: - Agent Panel Content (embeddable)

/// The skills management content, usable standalone (e.g. inside IdentityPanel)
/// or wrapped in a VSidePanel via AgentPanel.
struct AgentPanelContent: View {
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onSkillsChanged: (() -> Void)?
    let daemonClient: DaemonClient

    @StateObject private var skillsManager: SkillsManager
    @State private var selectedTab: SkillsTab = .installed
    @State private var expandedSkillId: String?
    @State private var selectedSkillSlug: String?
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?

    private enum SkillsTab {
        case installed, available
    }

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, daemonClient: DaemonClient) {
        self.onInvokeSkill = onInvokeSkill
        self.onSkillsChanged = onSkillsChanged
        self.daemonClient = daemonClient
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Tab bar
            VStack(spacing: 0) {
                HStack(spacing: VSpacing.xl) {
                    tabButton("Installed", tab: .installed)
                    tabButton("Available", tab: .available)
                    Spacer()
                }

                Divider().background(VColor.surfaceBorder)
            }
            .padding(.bottom, VSpacing.lg)

            // Tab content
            switch selectedTab {
            case .installed:
                skillsContent
            case .available:
                availableSkillsContent
            }
        }
        .onAppear {
            skillsManager.fetchSkills()
        }
        .onChange(of: skillsManager.skills.map(\.id)) {
            onSkillsChanged?()
            if let selectedId = selectedInstalledSkillId,
               !skillsManager.skills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
        }
        .sheet(item: $skillToDelete) { skill in
            SkillDeleteConfirmView(
                skillName: skill.name,
                onDelete: {
                    skillsManager.uninstallSkill(id: skill.id)
                    skillToDelete = nil
                },
                onCancel: {
                    skillToDelete = nil
                }
            )
        }
    }

    @ViewBuilder
    private func tabButton(_ label: String, tab: SkillsTab) -> some View {
        let isActive = selectedTab == tab
        Button {
            withAnimation(VAnimation.fast) { selectedTab = tab }
        } label: {
            VStack(spacing: VSpacing.sm) {
                Text(label)
                    .font(VFont.body)
                    .foregroundColor(isActive ? VColor.textPrimary : VColor.textMuted)
                    .padding(.bottom, VSpacing.xs)

                Rectangle()
                    .fill(isActive ? VColor.textPrimary : Color.clear)
                    .frame(height: 2)
            }
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
                    installAttemptId = nil
                }
            }
        }
        .onChange(of: skillsManager.searchResults) {
            if let slug = selectedSkillSlug,
               !skillsManager.searchResults.contains(where: { $0.slug == slug }) {
                selectedSkillSlug = nil
                skillsManager.clearInspection()
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
            .background(VColor.backgroundSubtle)
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
                            .foregroundColor(skillSortOrder == order ? VColor.accent : VColor.textMuted)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xs)
                            .background(skillSortOrder == order ? VColor.accent.opacity(0.15) : Color.clear)
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
                        .foregroundColor(VColor.accent)
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
    @State private var installAttemptId: UUID?
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
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.textPrimary)

                Text(starter.description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .lineLimit(2)
            }

            Spacer()

            Text("Included")
                .font(VFont.caption)
                .foregroundColor(VColor.success)
        }
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
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
        let isNew = !skill.isVellum && skill.createdAt > 0 && Date().timeIntervalSince(
            Date(timeIntervalSince1970: Double(skill.createdAt) / 1000)
        ) < 7 * 86400

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.md) {
                // Tappable area: icon + name + description
                HStack(spacing: VSpacing.md) {
                    Image(systemName: skill.isVellum ? "v.square.fill" : "shippingbox.fill")
                        .font(.system(size: 16))
                        .foregroundColor(skill.isVellum ? VColor.accent : VColor.textMuted)
                        .frame(width: 24)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: VSpacing.sm) {
                            Text(skill.name)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.textPrimary)

                            if skill.isVellum {
                                Text("VELLUM")
                                    .font(VFont.small)
                                    .foregroundColor(VColor.accent)
                            } else if isNew {
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

                Spacer()

                VButton(
                    label: isInstalling ? "Installing..." : "Install",
                    icon: isInstalling ? nil : "arrow.down.circle.fill",
                    style: .primary,
                    isDisabled: installingSlug != nil
                ) {
                    guard installingSlug == nil else { return }
                    let attemptId = UUID()
                    installingSlug = skill.slug
                    installAttemptId = attemptId
                    skillsManager.installSkill(slug: skill.slug)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                        if installingSlug == skill.slug && installAttemptId == attemptId {
                            installingSlug = nil
                            installAttemptId = nil
                        }
                    }
                }
            }

            // Trust signals row
            HStack(spacing: VSpacing.lg) {
                if skill.isVellum {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 9))
                        Text("First-party")
                    }
                } else {
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
            }
            .font(VFont.small)
            .foregroundColor(VColor.textMuted)
            .padding(.leading, 24 + VSpacing.md)
        }
        .padding(VSpacing.lg)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(VAnimation.standard) {
                selectedSkillSlug = skill.slug
                if !skill.isVellum {
                    skillsManager.inspectSkill(slug: skill.slug)
                }
            }
        }
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Skill Detail View

    @ViewBuilder
    private func skillDetailView(slug: String, searchItem: ClawhubSkillItem) -> some View {
        let isNew = !searchItem.isVellum && searchItem.createdAt > 0 && Date().timeIntervalSince(
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

                if searchItem.isVellum {
                    Text("VELLUM")
                        .font(VFont.small)
                        .foregroundColor(VColor.accent)
                } else if isNew {
                    Text("NEW")
                        .font(VFont.small)
                        .foregroundColor(Amber._500)
                }

                Spacer()

                detailInstallButton(slug: slug)
            }

            // Author/source row
            if searchItem.isVellum {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 12))
                        .foregroundColor(VColor.accent)
                    Text("First-party skill by Vellum")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if let owner = skillsManager.inspectedSkill?.owner {
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

            // Stats row — vellum skills show first-party badge; community shows stats
            if searchItem.isVellum {
                HStack(spacing: VSpacing.lg) {
                    statItem(icon: "checkmark.seal.fill", value: "First-party")
                }
            } else if let stats = skillsManager.inspectedSkill?.stats {
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
            if !searchItem.isVellum {
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
            }

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
                    .foregroundColor(VColor.success)
                if let changelog = version.changelog, !changelog.isEmpty {
                    Text(changelog)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.surfaceSubtle)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }

        // SKILL.md content
        if let md = data.skillMdContentString, !md.isEmpty {
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
                .background(VColor.surfaceSubtle)
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

        VButton(
            label: isSuccess ? "Installed!" : (isInstalling ? "Installing..." : "Install"),
            icon: isSuccess ? "checkmark.circle.fill" : (isInstalling ? nil : "arrow.down.circle.fill"),
            style: .primary,
            size: .small,
            isFullWidth: false,
            isDisabled: isInstalling || isSuccess
        ) {
            guard installingSlug == nil, !isSuccess else { return }
            let attemptId = UUID()
            installingSlug = slug
            installAttemptId = attemptId
            skillsManager.installSkill(slug: slug)
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                if installingSlug == slug && installAttemptId == attemptId {
                    installingSlug = nil
                    installAttemptId = nil
                }
            }
        }

        // Error message
        if isError, let msg = errorMessage {
            Text(msg)
                .font(VFont.caption)
                .foregroundColor(Danger._500)
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
        if let selectedId = selectedInstalledSkillId,
           let skill = userSkills.first(where: { $0.id == selectedId }) {
            installedSkillDetailView(skill)
        } else if skillsManager.isLoading {
            HStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Spacer()
            }
            .frame(height: 60)
        } else if userSkills.isEmpty {
            Text("No skills installed")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.sm)
        } else {
            VStack(spacing: VSpacing.md) {
                ForEach(userSkills) { skill in
                    skillCard(skill)
                }
            }
        }
    }

    private func skillCard(_ skill: SkillInfo) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                HStack(spacing: VSpacing.md) {
                    skillIcon(skill.emoji)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: VSpacing.sm) {
                            Text(skill.name)
                                .font(VFont.bodyBold)
                                .foregroundColor(VColor.textPrimary)

                            if skill.updateAvailable {
                                Text("UPDATE")
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

                Spacer(minLength: VSpacing.lg)

                VButton(label: "Use", icon: "bolt.fill", style: .primary) {
                    onInvokeSkill?(skill)
                }
            }

            HStack(spacing: VSpacing.lg) {
                skillMetaItem(icon: "checkmark.circle.fill", value: "Installed", color: VColor.success)
                skillMetaItem(icon: "shippingbox", value: sourceLabel(skill.source))

                if let installedVersion = skill.installedVersion, !installedVersion.isEmpty {
                    skillMetaItem(icon: "tag", value: "v\(installedVersion)")
                }

                if skill.updateAvailable {
                    if let latestVersion = skill.latestVersion, !latestVersion.isEmpty {
                        skillMetaItem(icon: "arrow.up.circle", value: "v\(latestVersion) available", color: Amber._500)
                    } else {
                        skillMetaItem(icon: "arrow.up.circle", value: "Update available", color: Amber._500)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.leading, 24 + VSpacing.md)
        }
        .padding(VSpacing.lg)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(VAnimation.standard) {
                selectedInstalledSkillId = skill.id
                skillsManager.fetchSkillBody(skillId: skill.id)
            }
        }
        .vCard(background: VColor.surfaceSubtle)
    }

    // MARK: - Installed Skill Detail View

    @ViewBuilder
    private func installedSkillDetailView(_ skill: SkillInfo) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Back button
            Button(action: {
                withAnimation(VAnimation.standard) {
                    selectedInstalledSkillId = nil
                }
            }) {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Installed Skills")
                        .font(VFont.caption)
                }
                .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)

            // Title row
            HStack(spacing: VSpacing.sm) {
                skillIcon(skill.emoji)

                Text(skill.name)
                    .font(VFont.cardTitle)
                    .foregroundColor(VColor.textPrimary)

                if skill.updateAvailable {
                    Text("UPDATE")
                        .font(VFont.small)
                        .foregroundColor(Amber._500)
                }
            }

            // Description
            if !skill.description.isEmpty {
                Text(skill.description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Meta info
            HStack(spacing: VSpacing.lg) {
                skillMetaItem(icon: "checkmark.circle.fill", value: "Installed", color: VColor.success)
                skillMetaItem(icon: "shippingbox", value: sourceLabel(skill.source))

                if let installedVersion = skill.installedVersion, !installedVersion.isEmpty {
                    skillMetaItem(icon: "tag", value: "v\(installedVersion)")
                }

                if skill.updateAvailable {
                    if let latestVersion = skill.latestVersion, !latestVersion.isEmpty {
                        skillMetaItem(icon: "arrow.up.circle", value: "v\(latestVersion) available", color: Amber._500)
                    } else {
                        skillMetaItem(icon: "arrow.up.circle", value: "Update available", color: Amber._500)
                    }
                }
            }

            // Skill body content
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    skillBody(for: skill.id)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 300)
            .background(VColor.surfaceSubtle)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )

            // Action buttons
            HStack(spacing: VSpacing.md) {
                VButton(label: "Use", icon: "bolt.fill", style: .primary, isFullWidth: true) {
                    onInvokeSkill?(skill)
                }

                if skill.source == "managed" {
                    VButton(label: "Delete", icon: "trash", style: .danger) {
                        skillToDelete = skill
                    }
                }
            }
        }
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "bundled":
            return "Bundled"
        case "managed":
            return "Managed"
        case "workspace":
            return "Workspace"
        case "clawhub":
            return "ClawHub"
        case "extra":
            return "Extra"
        default:
            return source.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private func skillMetaItem(icon: String, value: String, color: Color = VColor.textMuted) -> some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: icon)
                .font(.system(size: 9))
            Text(value)
        }
        .font(VFont.small)
        .foregroundColor(color)
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
                .frame(width: 24, height: 24)
        } else {
            Image(systemName: "bolt.fill")
                .font(.system(size: 13))
                .foregroundColor(VColor.textMuted)
                .frame(width: 24, height: 24)
        }
    }
}

// MARK: - Agent Panel (standalone, wrapped in VSidePanel)

struct AgentPanel: View {
    var onClose: () -> Void
    var onInvokeSkill: ((SkillInfo) -> Void)?
    let daemonClient: DaemonClient

    /// Maximum width of the centered content area.
    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack(alignment: .center) {
                    Text("Skills")
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)

                Divider().background(VColor.surfaceBorder)
                    .padding(.bottom, VSpacing.xl)

                AgentPanelContent(onInvokeSkill: onInvokeSkill, daemonClient: daemonClient)
            }
            .frame(maxWidth: maxContentWidth)
            .padding(.horizontal, VSpacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .background(VColor.backgroundSubtle)
    }
}

#Preview {
    AgentPanel(onClose: {}, daemonClient: DaemonClient())
}
