import SwiftUI

struct AgentPanel: View {
    var onClose: () -> Void
    let daemonClient: DaemonClient

    @StateObject private var skillsManager: SkillsManager
    @State private var expandedSkillId: String?

    init(onClose: @escaping () -> Void, daemonClient: DaemonClient) {
        self.onClose = onClose
        self.daemonClient = daemonClient
        _skillsManager = StateObject(wrappedValue: SkillsManager(daemonClient: daemonClient))
    }

    var body: some View {
        VSidePanel(title: "Agent", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                sectionHeader("Skills")
                skillsContent

                Divider()

                sectionHeader("Nodes")
                VEmptyState(title: "No nodes", subtitle: "Agent nodes will appear here", icon: "point.3.connected.trianglepath.dotted")
                    .frame(height: 150)
            }
        }
        .onAppear {
            skillsManager.fetchSkills()
        }
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
            .frame(height: 150)
        } else if skillsManager.skills.isEmpty {
            VEmptyState(title: "No skills", subtitle: "Agent skills will appear here", icon: "bolt.fill")
                .frame(height: 150)
        } else {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(skillsManager.skills) { skill in
                    skillRow(skill)
                }
            }
        }
    }

    private func skillRow(_ skill: SkillSummaryItem) -> some View {
        let isExpanded = expandedSkillId == skill.id

        return VStack(alignment: .leading, spacing: 0) {
            Button(action: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isExpanded {
                        expandedSkillId = nil
                    } else {
                        expandedSkillId = skill.id
                        skillsManager.fetchSkillBody(skillId: skill.id)
                    }
                }
            }) {
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                        .frame(width: 12)
                        .padding(.top, 3)

                    skillIcon(skill.icon)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(skill.name)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                        Text(skill.description)
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                            .lineLimit(isExpanded ? nil : 2)
                    }

                    Spacer()
                }
                .padding(.vertical, VSpacing.sm)
                .padding(.horizontal, VSpacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                skillBody(for: skill.id)
                    .padding(.leading, 12 + VSpacing.sm)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.bottom, VSpacing.sm)
            }
        }
        .background(isExpanded ? VColor.surface.opacity(0.5) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
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
                .frame(width: 16, height: 16)
        } else {
            Image(systemName: "bolt.fill")
                .font(.system(size: 12))
                .foregroundColor(VColor.textMuted)
                .frame(width: 16, height: 16)
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(VFont.captionMedium)
            .foregroundColor(VColor.textSecondary)
    }
}

#Preview {
    AgentPanel(onClose: {}, daemonClient: DaemonClient())
}
