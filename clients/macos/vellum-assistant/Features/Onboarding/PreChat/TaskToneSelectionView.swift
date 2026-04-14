import SwiftUI
import VellumAssistantShared

@MainActor
struct TaskToneSelectionView: View {
    // MARK: - Bindings

    @Binding var selectedTasks: Set<String>
    @Binding var toneValue: Double

    // MARK: - Callbacks

    var onContinue: () -> Void
    var onSkip: () -> Void

    // MARK: - Private State

    @State private var showTitle = false
    @State private var showContent = false
    @State private var showCharacters = false
    @State private var hoveredTask: String?

    private static let welcomeCharacters: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "welcome-characters", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    // MARK: - Task Categories

    private struct TaskCategory: Identifiable {
        let id: String
        let icon: VIcon
        let label: String
    }

    private let taskCategories: [TaskCategory] = [
        TaskCategory(id: "code-building", icon: .wrench, label: "Code & building"),
        TaskCategory(id: "writing", icon: .pencil, label: "Writing & communication"),
        TaskCategory(id: "research", icon: .search, label: "Research & analysis"),
        TaskCategory(id: "project-management", icon: .clipboardList, label: "Project management"),
        TaskCategory(id: "scheduling", icon: .calendar, label: "Scheduling & calendar"),
        TaskCategory(id: "personal", icon: .user, label: "Personal / life stuff"),
    ]

    // MARK: - Tone Label

    private var toneLabel: String {
        if toneValue < 0.25 {
            return "Casual"
        } else if toneValue > 0.75 {
            return "Professional"
        } else {
            return "Balanced"
        }
    }

    // MARK: - Body

    var body: some View {
        // Header
        Text("What do you work on most?")
            .font(VFont.titleLarge)
            .foregroundStyle(VColor.contentDefault)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xxl)

        // Content
        VStack(spacing: VSpacing.xl) {
            // Task categories
            VStack(spacing: VSpacing.xs) {
                ForEach(taskCategories) { category in
                    taskRow(category)
                }
            }

            // Tone slider section
            VStack(spacing: VSpacing.sm) {
                Text("Communication tone")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(spacing: VSpacing.xs) {
                    Slider(value: $toneValue, in: 0...1, step: 0.5)
                        .tint(VColor.primaryBase)

                    HStack {
                        Text("Casual")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer()
                        Text("Professional")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }

                Text(toneLabel)
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .frame(maxWidth: .infinity, alignment: .center)
            }

            // Footer buttons
            VStack(spacing: VSpacing.sm) {
                VButton(label: "Continue", style: .primary, isFullWidth: true) {
                    onContinue()
                }

                VButton(label: "I'll set this up later", style: .ghost, tintColor: VColor.contentTertiary) {
                    onSkip()
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            withAnimation(VAnimation.slow.delay(0.1)) {
                showTitle = true
            }
            withAnimation(VAnimation.slow.delay(0.3)) {
                showContent = true
            }
        }

        Spacer()

        // Characters footer (same pattern as other onboarding steps)
        if let characters = Self.welcomeCharacters {
            Image(nsImage: characters)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
                .clipShape(UnevenRoundedRectangle(
                    topLeadingRadius: 0,
                    bottomLeadingRadius: VRadius.window,
                    bottomTrailingRadius: VRadius.window,
                    topTrailingRadius: 0
                ))
                .opacity(showCharacters ? 1 : 0)
                .offset(y: showCharacters ? 0 : 30)
                .animation(VAnimation.slow.delay(0.5), value: showCharacters)
                .onAppear { showCharacters = true }
                .accessibilityHidden(true)
        }
    }

    // MARK: - Task Row

    @ViewBuilder
    private func taskRow(_ category: TaskCategory) -> some View {
        let isSelected = selectedTasks.contains(category.id)

        Button {
            withAnimation(VAnimation.fast) {
                if isSelected {
                    selectedTasks.remove(category.id)
                } else {
                    selectedTasks.insert(category.id)
                }
            }
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(category.icon, size: 16)
                    .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                    .frame(width: 24, alignment: .center)

                Text(category.label)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Spacer()

                ZStack {
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(isSelected ? VColor.primaryBase : Color.clear)

                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .strokeBorder(isSelected ? Color.clear : VColor.borderElement, lineWidth: 1.5)

                    if isSelected {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.contentInset)
                    }
                }
                .frame(width: 20, height: 20)
            }
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : (hoveredTask == category.id ? VColor.surfaceHover : VColor.surfaceLift))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(isSelected ? VColor.primaryBase.opacity(0.3) : (hoveredTask == category.id ? VColor.borderHover : VColor.surfaceBase), lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredTask = hovering ? category.id : nil
            }
        })
        .accessibilityLabel(category.label)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isToggle)
    }
}
