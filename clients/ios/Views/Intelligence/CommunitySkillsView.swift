#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct CommunitySkillsView: View {
    @ObservedObject var skillsStore: SkillsStore
    @State private var searchQuery = ""

    var body: some View {
        Group {
            if skillsStore.isSearching && skillsStore.searchResults.isEmpty {
                loadingState
            } else if skillsStore.searchResults.isEmpty && !searchQuery.isEmpty {
                noResultsState
            } else if skillsStore.searchResults.isEmpty {
                browsePromptState
            } else {
                resultsList
            }
        }
        .navigationTitle("Community Skills")
        .searchable(text: $searchQuery, prompt: "Search skills...")
        .task {
            // Load initial browse results
            skillsStore.searchSkills(query: "", force: true)
        }
        .task(id: searchQuery) {
            // Debounce search
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            skillsStore.searchSkills(query: searchQuery, force: true)
        }
    }

    // MARK: - Results List

    private var resultsList: some View {
        List {
            ForEach(skillsStore.searchResults) { item in
                NavigationLink {
                    CommunitySkillDetailView(item: item, skillsStore: skillsStore)
                } label: {
                    communitySkillRow(item)
                }
            }
        }
    }

    // MARK: - Row

    private func communitySkillRow(_ item: ClawhubSkillItem) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Community skills don't have an emoji field, use a default icon
            VIconView(.puzzle, size: 20)
                .foregroundColor(VColor.primaryBase)
                .frame(width: 32)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(item.name)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)

                    if item.isVellum {
                        Text("Vellum")
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.blue.opacity(0.15)))
                            .foregroundColor(.blue)
                    }
                }

                if !item.author.isEmpty {
                    Text("by \(item.author)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }

                if !item.description.isEmpty {
                    Text(item.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(2)
                }
            }

            Spacer()

            if item.stars > 0 {
                HStack(spacing: 2) {
                    VIconView(.star, size: 10)
                        .foregroundColor(.yellow)
                    Text("\(item.stars)")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Skill: \(item.name) by \(item.author)\(item.isVellum ? ", Vellum verified" : "")\(item.stars > 0 ? ", \(item.stars) stars" : "")")
        .accessibilityHint("Opens skill details")
    }

    // MARK: - States

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Searching skills...")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var noResultsState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.search, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("No Results")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("No skills found matching \"\(searchQuery)\". Try a different search term.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No results. No skills found matching \(searchQuery). Try a different search term.")
    }

    private var browsePromptState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.globe, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("Community Skills")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Search for skills to enhance your assistant's capabilities.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Community Skill Detail View

/// Detail view for a ClawhubSkillItem (from search results).
/// Inspects the full skill data and offers install.
struct CommunitySkillDetailView: View {
    let item: ClawhubSkillItem
    @ObservedObject var skillsStore: SkillsStore
    @Environment(\.dismiss) private var dismiss

    /// Whether this skill is already installed.
    private var isInstalled: Bool {
        skillsStore.skills.contains { $0.name == item.name || $0.id == item.slug }
    }

    var body: some View {
        List {
            // Header
            Section {
                VStack(spacing: VSpacing.sm) {
                    VIconView(.puzzle, size: 48)
                        .foregroundColor(VColor.primaryBase)
                        .accessibilityHidden(true)

                    Text(item.name)
                        .font(VFont.title)
                        .foregroundColor(VColor.contentDefault)

                    if !item.author.isEmpty {
                        Text("by \(item.author)")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }

                    if !item.description.isEmpty {
                        Text(item.description)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, VSpacing.sm)
            }

            // Details
            Section("Details") {
                detailRow(label: "Version", value: item.version)
                detailRow(label: "Source", value: item.isVellum ? "Vellum" : "Community")
                if item.stars > 0 {
                    detailRow(label: "Stars", value: "\(item.stars)")
                }
                if item.installs > 0 {
                    detailRow(label: "Installs", value: "\(item.installs)")
                }
            }

            // Inspect data
            if let inspected = skillsStore.inspectedSkill {
                Section("About") {
                    if !inspected.skill.summary.isEmpty {
                        Text(inspected.skill.summary)
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }

                    if let owner = inspected.owner {
                        detailRow(label: "Owner", value: owner.displayName)
                    }
                }
            } else if skillsStore.isInspecting {
                Section("About") {
                    HStack {
                        Spacer()
                        ProgressView()
                            .padding()
                        Spacer()
                    }
                }
            }

            // Actions
            Section {
                if isInstalled {
                    Text("Already installed")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentTertiary)
                } else {
                    Button {
                        skillsStore.installSkill(slug: item.slug)
                    } label: {
                        HStack {
                            VIconView(.arrowDown, size: 16)
                            Text("Install Skill")
                        }
                    }

                    if let result = skillsStore.installResult, result.slug == item.slug {
                        if result.success {
                            Text("Installed successfully!")
                                .font(VFont.caption)
                                .foregroundColor(.green)
                        } else if let error = result.error {
                            Text("Error: \(error)")
                                .font(VFont.caption)
                                .foregroundColor(.red)
                        }
                    }
                }
            }
        }
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            skillsStore.inspectSkill(slug: item.slug)
        }
        .onDisappear {
            skillsStore.clearInspection()
        }
    }

    private func detailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
            Spacer()
            Text(value)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}
#endif
