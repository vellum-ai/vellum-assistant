import SwiftUI
import VellumAssistantShared

// MARK: - Agent Panel Content (embeddable)

/// Which skills tab to display.
enum SkillsTab {
    case installed, available
}

/// The skills management content, usable standalone (e.g. inside IdentityPanel)
/// or wrapped in a VSidePanel via AgentPanel.
///
/// When `visibleTab` is set, the internal tab bar is hidden and only
/// the specified tab's content is shown. When nil (default), the full
/// tab bar is displayed — preserving backward compatibility.
struct AgentPanelContent: View {
    var onInvokeSkill: ((SkillInfo) -> Void)?
    var onSkillsChanged: (() -> Void)?
    let daemonClient: DaemonClient

    /// When non-nil, locks the view to a single tab and hides the tab bar.
    var visibleTab: SkillsTab?

    @StateObject private var skillsManager: SkillsManager
    @State private var selectedTab: SkillsTab = .installed
    @State private var expandedSkillId: String?
    @State private var selectedSkillSlug: String?
    @State private var selectedInstalledSkillId: String?
    @State private var skillToDelete: SkillInfo?
    @State private var showNewSkillSheet = false
    @State private var selectedCategory: SkillCategory?
    @State private var expandedDetailSkillId: String?

    init(onInvokeSkill: ((SkillInfo) -> Void)? = nil, onSkillsChanged: (() -> Void)? = nil, daemonClient: DaemonClient, visibleTab: SkillsTab? = nil) {
        self.onInvokeSkill = onInvokeSkill
        self.onSkillsChanged = onSkillsChanged
        self.daemonClient = daemonClient
        self.visibleTab = visibleTab
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
        if let visibleTab {
            _selectedTab = State(initialValue: visibleTab)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Search bar for available skills tab (installed tab has its own in the right panel)
            if (visibleTab ?? selectedTab) == .available {
                VSearchBar(placeholder: "Search skills...", text: $globalSkillSearchQuery)
                    .padding(.bottom, VSpacing.lg)
            }

            // Tab bar — hidden when locked to a single tab via visibleTab
            if visibleTab == nil {
                VStack(spacing: 0) {
                    HStack(spacing: VSpacing.xl) {
                        tabButton(installedTabTitle, tab: .installed)
                        tabButton(availableTabTitle, tab: .available)
                        Spacer()
                        Button {
                            showNewSkillSheet = true
                        } label: {
                            HStack(spacing: VSpacing.xs) {
                                VIconView(.plus, size: 14)
                                Text("New Skill")
                            }
                            .font(VFont.body)
                            .foregroundColor(VColor.accent)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("New Skill")
                    }

                    Divider().background(VColor.surfaceBorder)
                }
                .padding(.bottom, VSpacing.lg)
            }

            // Tab content — use visibleTab when locked, otherwise selectedTab
            switch visibleTab ?? selectedTab {
            case .installed:
                skillsContent
            case .available:
                availableSkillsContent
            }
        }
        .onAppear {
            skillsManager.fetchSkills()
            skillsManager.searchSkills()
        }
        .onDisappear {
            installTimeoutTask?.cancel()
        }
        .onChange(of: skillsManager.skills.map(\.id)) {
            onSkillsChanged?()
            if let selectedId = selectedInstalledSkillId,
               !skillsManager.skills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
        }
        .onChange(of: globalSkillSearchQuery) {
            // Clear stale selections when search filters them out
            if let selectedId = selectedInstalledSkillId,
               !filteredUserSkills.contains(where: { $0.id == selectedId }) {
                selectedInstalledSkillId = nil
            }
            if let slug = selectedSkillSlug,
               !availableClawhubSkills.contains(where: { $0.slug == slug }) {
                selectedSkillSlug = nil
                skillsManager.clearInspection()
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
        .sheet(isPresented: $showNewSkillSheet) {
            NewSkillSheet(skillsManager: skillsManager)
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

    /// Available skills filtered to exclude already-installed ones.
    private var availableClawhubSkills: [ClawhubSkillItem] {
        let installedNames = Set(skillsManager.skills.map(\.name))

        var filtered = skillsManager.searchResults
            .filter { !installedNames.contains($0.name) }

        // Local fuzzy filter by name/description
        if hasActiveSearch {
            let query = normalizedSkillQuery
            filtered = filtered.filter {
                $0.name.lowercased().contains(query) ||
                $0.description.lowercased().contains(query) ||
                $0.slug.lowercased().contains(query)
            }
        }

        return filtered.sorted { $0.installs > $1.installs }
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
        ScrollView {
            VStack(spacing: VSpacing.lg) {
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
                } else if hasActiveSearch {
                    VStack(spacing: VSpacing.md) {
                        VEmptyState(
                            title: "No matches in Available",
                            subtitle: "No available skills matched \"\(globalSkillSearchQuery)\"",
                            icon: VIcon.search.rawValue
                        )

                        if visibleTab == nil, !filteredUserSkills.isEmpty {
                            Button {
                                withAnimation(VAnimation.fast) { selectedTab = .installed }
                            } label: {
                                Text("Show \(filteredUserSkills.count) match\(filteredUserSkills.count == 1 ? "" : "es") in Installed")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.accent)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(minHeight: 100)
                }

            }
        }
        .onAppear {
            skillsManager.searchSkills()
        }
    }

    @State private var installingSlug: String?
    @State private var installAttemptId: UUID?
    @State private var installTimeoutTask: Task<Void, Never>?
    @State private var globalSkillSearchQuery = ""

    private var normalizedSkillQuery: String {
        globalSkillSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var hasActiveSearch: Bool { !normalizedSkillQuery.isEmpty }

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
        let installedNames = Set(skillsManager.skills.map(\.name))
        let isAlreadyInstalled = installedNames.contains(skill.name)
        let isInstalling = installingSlug == skill.slug
        let isNew = !skill.isVellum && skill.createdAt > 0 && Date().timeIntervalSince(
            Date(timeIntervalSince1970: Double(skill.createdAt) / 1000)
        ) < 7 * 86400

        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                VIconView(skill.isVellum ? .package : .package, size: 16)
                    .foregroundColor(skill.isVellum ? VColor.accent : VColor.textMuted)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(skill.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)

                    Text(skill.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(2)

                    // Pill badges row
                    HStack(spacing: VSpacing.xs) {
                        if skill.isVellum {
                            VSkillTypePill(type: .core)
                        } else if isAlreadyInstalled {
                            VSkillTypePill(type: .installed)
                        }

                        if isNew {
                            VSkillTypePill(type: .custom(
                                label: "New",
                                icon: "sparkles",
                                foreground: Amber._500,
                                background: Amber._500.opacity(0.15)
                            ))
                        }
                    }
                    .padding(.top, VSpacing.xxs)
                }

                Spacer(minLength: VSpacing.lg)

                if isAlreadyInstalled {
                    Text("Installed")
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                } else {
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
                        installTimeoutTask?.cancel()
                        installTimeoutTask = Task {
                            try? await Task.sleep(nanoseconds: 10_000_000_000)
                            guard !Task.isCancelled else { return }
                            if installingSlug == skill.slug && installAttemptId == attemptId {
                                installingSlug = nil
                                installAttemptId = nil
                            }
                        }
                    }
                }
            }

            // Trust signals row
            HStack(spacing: VSpacing.lg) {
                if skill.isVellum {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.badgeCheck, size: 9)
                        Text("First-party")
                    }
                } else {
                    if !skill.author.isEmpty {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.user, size: 9)
                            Text(skill.author)
                        }
                    }

                    HStack(spacing: VSpacing.xs) {
                        VIconView(.star, size: 9)
                        Text("\(skill.stars)")
                    }

                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleArrowDown, size: 9)
                        Text("\(skill.installs)")
                    }

                    if !skillAge(skill.createdAt).isEmpty {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.clock, size: 9)
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
                    VIconView(.chevronLeft, size: 11)
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
                    VIconView(.badgeCheck, size: 12)
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
                            VIconView(.circleUser, size: 20)
                                .foregroundColor(VColor.textMuted)
                        }
                        .frame(width: 20, height: 20)
                        .clipShape(Circle())
                    } else {
                        VIconView(.circleUser, size: 16)
                            .foregroundColor(VColor.textMuted)
                    }
                    Text(owner.displayName.isEmpty ? owner.handle : owner.displayName)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if !searchItem.author.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.user, size: 12)
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
                    statItem(icon: .badgeCheck, value: "First-party")
                }
            } else if let stats = skillsManager.inspectedSkill?.stats {
                HStack(spacing: VSpacing.lg) {
                    statItem(icon: .star, value: "\(stats.stars)")
                    statItem(icon: .circleArrowDown, value: "\(stats.installs)")
                    statItem(icon: .arrowDownToLine, value: "\(stats.downloads)")
                    if stats.versions > 0 {
                        statItem(icon: .tag, value: "\(stats.versions) versions")
                    }
                    if !skillAge(searchItem.createdAt).isEmpty {
                        statItem(icon: .clock, value: skillAge(searchItem.createdAt))
                    }
                }
            } else {
                // Baseline stats from search results
                HStack(spacing: VSpacing.lg) {
                    statItem(icon: .star, value: "\(searchItem.stars)")
                    statItem(icon: .circleArrowDown, value: "\(searchItem.installs)")
                    if !skillAge(searchItem.createdAt).isEmpty {
                        statItem(icon: .clock, value: skillAge(searchItem.createdAt))
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
                        VIconView(.triangleAlert, size: 11)
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
                        VIconView(.fileText, size: 10)
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

    private func statItem(icon: VIcon, value: String) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 9)
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

        VStack(alignment: .trailing, spacing: VSpacing.xs) {
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
                installTimeoutTask?.cancel()
                installTimeoutTask = Task {
                    try? await Task.sleep(nanoseconds: 10_000_000_000)
                    guard !Task.isCancelled else { return }
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
    }

    // MARK: - Skills Tab

    /// Skills to show in the Skills tab.
    private var userSkills: [SkillInfo] {
        skillsManager.skills
    }

    /// Installed skills filtered by the global search query.
    private var filteredUserSkills: [SkillInfo] {
        guard hasActiveSearch else { return userSkills }
        let query = normalizedSkillQuery
        return userSkills.filter {
            $0.name.lowercased().contains(query) ||
            $0.description.lowercased().contains(query) ||
            $0.id.lowercased().contains(query) ||
            sourceLabel($0.source).lowercased().contains(query)
        }
    }

    /// Installed skills further filtered by the selected category.
    private var categoryFilteredSkills: [SkillInfo] {
        guard let category = selectedCategory else { return filteredUserSkills }
        return filteredUserSkills.filter { inferCategory($0) == category }
    }

    /// Count of installed skills per category (based on search-filtered list).
    private func skillCount(for category: SkillCategory) -> Int {
        filteredUserSkills.filter { inferCategory($0) == category }.count
    }

    private var installedTabTitle: String {
        hasActiveSearch ? "Installed (\(filteredUserSkills.count))" : "Installed"
    }

    private var availableTabTitle: String {
        hasActiveSearch ? "Available (\(availableClawhubSkills.count))" : "Available"
    }

    // MARK: - Category Sidebar

    @ViewBuilder
    private var categorySidebar: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            SidebarPrimaryRow(
                icon: VIcon.layoutGrid.rawValue,
                label: "All",
                isActive: selectedCategory == nil
            ) {
                withAnimation(VAnimation.fast) { selectedCategory = nil }
            }

            ForEach(SkillCategory.allCases, id: \.rawValue) { category in
                SidebarPrimaryRow(
                    icon: category.icon.rawValue,
                    label: category.displayName,
                    isActive: selectedCategory == category
                ) {
                    withAnimation(VAnimation.fast) { selectedCategory = category }
                }
            }

            Spacer()
        }
        .frame(width: 180)
    }

    // MARK: - Installed Skills Content

    @ViewBuilder
    private var skillsContent: some View {
        if let selectedId = selectedInstalledSkillId,
           let skill = filteredUserSkills.first(where: { $0.id == selectedId }) {
            installedSkillDetailView(skill)
        } else if skillsManager.isLoading {
            HStack {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Spacer()
            }
            .frame(height: 60)
        } else if filteredUserSkills.isEmpty {
            if hasActiveSearch {
                VStack(spacing: VSpacing.md) {
                    VEmptyState(
                        title: "No matches in Installed",
                        subtitle: "No installed skills matched \"\(globalSkillSearchQuery)\"",
                        icon: VIcon.search.rawValue
                    )

                    if visibleTab == nil, !availableClawhubSkills.isEmpty {
                        Button {
                            withAnimation(VAnimation.fast) { selectedTab = .available }
                        } label: {
                            Text("Show \(availableClawhubSkills.count) match\(availableClawhubSkills.count == 1 ? "" : "es") in Available")
                                .font(VFont.caption)
                                .foregroundColor(VColor.accent)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(minHeight: 100)
            } else {
                VStack(spacing: VSpacing.md) {
                    Text("No skills installed")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    Button(action: { skillsManager.fetchSkills() }) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.refreshCw, size: 11)
                            Text("Refresh")
                                .font(VFont.caption)
                        }
                        .foregroundColor(VColor.accent)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, VSpacing.sm)
            }
        } else {
            HStack(alignment: .top, spacing: VSpacing.lg) {
                categorySidebar

                VStack(spacing: VSpacing.md) {
                    VSearchBar(placeholder: "Search skills", text: $globalSkillSearchQuery)

                    if categoryFilteredSkills.isEmpty {
                        VEmptyState(
                            title: "No skills in this category",
                            subtitle: selectedCategory.map { "No installed skills matched \($0.displayName)" } ?? "",
                            icon: "tray"
                        )
                        .frame(minHeight: 100)
                    } else {
                        ScrollView {
                            VStack(spacing: VSpacing.md) {
                                ForEach(categoryFilteredSkills) { skill in
                                    skillCard(skill)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func skillCard(_ skill: SkillInfo) -> some View {
        let isExpanded = expandedDetailSkillId == skill.id

        return VStack(alignment: .leading, spacing: 0) {
            // Top row: icon + info + remove button
            HStack(alignment: .top, spacing: VSpacing.md) {
                skillIcon(skill.emoji)

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(skill.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)

                    Text(skill.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(2)

                    VSkillTypePill(source: skill.source)
                        .padding(.top, VSpacing.sm)
                }

                Spacer(minLength: VSpacing.lg)

                // Remove button
                Button {
                    skillToDelete = skill
                } label: {
                    Text("Remove")
                        .font(VFont.caption)
                        .foregroundColor(Danger._500)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .strokeBorder(Danger._500, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }

            // Details toggle
            HStack {
                Spacer()
                VButton(
                    label: "Details",
                    rightIcon: isExpanded ? "chevron.up" : "chevron.down",
                    style: .ghost,
                    size: .small
                ) {
                    withAnimation(VAnimation.fast) {
                        if isExpanded {
                            expandedDetailSkillId = nil
                        } else {
                            expandedDetailSkillId = skill.id
                            skillsManager.fetchSkillBody(skillId: skill.id)
                        }
                    }
                }
            }
            .padding(.top, VSpacing.xs)

            // Expanded details content
            if isExpanded {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    skillBody(for: skill.id)
                }
                .padding(.top, VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .contentShape(Rectangle())
        .vCard(radius: VRadius.lg, background: VColor.surfaceSubtle)
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
                    VIconView(.chevronLeft, size: 11)
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

                // Source badge
                Text(sourceLabel(skill.source))
                    .font(VFont.small)
                    .foregroundColor(sourceBadgeColor(skill.source))
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(sourceBadgeColor(skill.source).opacity(0.15))
                    )

                // Provenance badge
                if let label = provenanceLabel(skill) {
                    Text(label)
                        .font(VFont.small)
                        .foregroundColor(provenanceBadgeColor(skill))
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill(provenanceBadgeColor(skill).opacity(0.15))
                        )
                }

                Spacer()

                if skill.source == "managed" {
                    VButton(label: "Remove", icon: VIcon.trash.rawValue, style: .danger, size: .small) {
                        skillToDelete = skill
                    }
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
                if let installedVersion = skill.installedVersion, !installedVersion.isEmpty {
                    skillMetaItem(icon: .tag, value: "v\(installedVersion)")
                }

                if skill.updateAvailable {
                    if let latestVersion = skill.latestVersion, !latestVersion.isEmpty {
                        skillMetaItem(icon: .circleArrowUp, value: "v\(latestVersion) available", color: Amber._500)
                    } else {
                        skillMetaItem(icon: .circleArrowUp, value: "Update available", color: Amber._500)
                    }
                }

                // Source link for third-party skills
                if let provenance = skill.provenance,
                   provenance.kind == "third-party",
                   let urlString = provenance.sourceUrl,
                   let url = URL(string: urlString) {
                    Link(destination: url) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.externalLink, size: 9)
                            Text("View on \(provenance.provider ?? "source")")
                                .font(VFont.small)
                        }
                        .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
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

        }
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "bundled":
            return "Core"
        case "managed", "clawhub":
            return "Installed"
        case "workspace":
            return "Created"
        case "extra":
            return "Extra"
        default:
            return source.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private func provenanceLabel(_ skill: SkillInfo) -> String? {
        guard let provenance = skill.provenance else { return nil }
        if provenance.kind == "first-party" {
            return provenance.provider ?? "Vellum"
        } else if provenance.kind == "third-party" {
            return provenance.provider ?? "Third-party"
        } else if provenance.kind == "local" {
            return "Local"
        }
        return nil
    }

    private func sourceBadgeColor(_ source: String) -> Color {
        switch source {
        case "bundled":
            return VColor.accent
        case "managed", "clawhub":
            return VColor.success
        case "workspace":
            return Amber._500
        default:
            return VColor.textMuted
        }
    }

    private func provenanceBadgeColor(_ skill: SkillInfo) -> Color {
        guard let provenance = skill.provenance else { return VColor.textMuted }
        switch provenance.kind {
        case "first-party":
            return VColor.accent
        case "third-party":
            return Amber._500
        default:
            return VColor.textMuted
        }
    }

    private func skillMetaItem(icon: VIcon, value: String, color: Color = VColor.textMuted) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 9)
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
            VIconView(.zap, size: 13)
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
            .padding(.bottom, VSpacing.xxl)
            .frame(maxWidth: .infinity)
        }
    }
}

#Preview {
    AgentPanel(onClose: {}, daemonClient: DaemonClient())
}
