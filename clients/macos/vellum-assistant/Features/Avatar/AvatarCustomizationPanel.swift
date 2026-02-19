import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Side panel for customizing the avatar's appearance.
/// Users can pick body/cheek colors, outfit items, and lock individual fields
/// so auto-evolution won't override them.
struct AvatarCustomizationPanel: View {
    let onClose: () -> Void

    @State private var appearance = AvatarAppearanceManager.shared
    @State private var evolutionState = AvatarEvolutionState()
    @State private var identity: IdentityInfo?

    /// All available color names from BodyColorScale, in a stable display order.
    private let colorNames: [String] = [
        "violet", "indigo", "blue", "cyan",
        "emerald", "green", "rose", "pink",
        "red", "orange", "amber", "slate"
    ]

    /// Available outfit options per field.
    private let hatOptions = ["none", "top_hat", "crown", "cap", "beanie", "wizard_hat", "cowboy_hat"]
    private let shirtOptions = ["none", "tshirt", "suit", "hoodie", "tank_top", "sweater"]
    private let accessoryOptions = ["none", "sunglasses", "monocle", "bowtie", "necklace", "scarf", "cape"]
    private let heldItemOptions = ["none", "sword", "staff", "shield", "balloon"]

    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                HStack(alignment: .center) {
                    Text("Customize Avatar")
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)

                Divider().background(VColor.surfaceBorder)
                    .padding(.bottom, VSpacing.xl)

                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    // Live avatar preview
                    avatarPreview

                    // Profile picture section
                    profilePictureSection

                    // Body Color section
                    colorGridSection(
                        title: "Body Color",
                        field: .bodyColor,
                        selectedColor: evolutionState.userOverrides[.bodyColor] ?? appearance.config.bodyColor
                    )

                    // Cheek Color section
                    colorGridSection(
                        title: "Cheek Color",
                        field: .cheekColor,
                        selectedColor: evolutionState.userOverrides[.cheekColor] ?? appearance.config.cheekColor
                    )

                    // Outfit section
                    outfitSection

                    // Reset button
                    resetButton
                }

                Spacer(minLength: VSpacing.xxl)
            }
            .frame(maxWidth: maxContentWidth)
            .padding(.horizontal, VSpacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .background(VColor.backgroundSubtle)
        .onAppear {
            evolutionState.load()
            identity = IdentityInfo.load()
        }
    }

    // MARK: - Avatar Preview

    @ViewBuilder
    private var avatarPreview: some View {
        HStack {
            Spacer()
            DinoSceneView(
                seed: identity?.name ?? "default",
                palette: appearance.palette,
                outfit: appearance.outfit
            )
            .frame(width: 140, height: 160)
            Spacer()
        }
    }

    // MARK: - Profile Picture

    @ViewBuilder
    private var profilePictureSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Profile Picture")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            if let customImage = appearance.customAvatarImage {
                HStack(spacing: VSpacing.md) {
                    Image(nsImage: customImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 48, height: 48)
                        .clipShape(Circle())

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Button("Change") { pickImage() }
                            .buttonStyle(.plain)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.accent)

                        Button("Remove") { appearance.clearCustomAvatar() }
                            .buttonStyle(.plain)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textMuted)
                    }
                }
            } else {
                Button {
                    pickImage()
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "photo")
                            .font(.system(size: 12, weight: .medium))
                        Text("Upload Custom Image")
                            .font(VFont.bodyMedium)
                    }
                    .foregroundColor(VColor.textSecondary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func pickImage() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .gif, .heic]
        panel.message = "Choose a profile picture"

        guard panel.runModal() == .OK, let url = panel.url,
              let image = NSImage(contentsOf: url) else { return }
        appearance.setCustomAvatar(image)
    }

    // MARK: - Color Grid Section

    @ViewBuilder
    private func colorGridSection(title: String, field: AvatarEvolutionState.AppearanceField, selectedColor: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            fieldHeader(title: title, field: field)

            let columns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 6)
            LazyVGrid(columns: columns, spacing: VSpacing.sm) {
                ForEach(colorNames, id: \.self) { name in
                    colorCircle(name: name, isSelected: selectedColor == name) {
                        setOverride(field: field, value: name)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func colorCircle(name: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        let displayColor = swiftUIColor(for: name)
        Button(action: action) {
            Circle()
                .fill(displayColor)
                .frame(width: 32, height: 32)
                .overlay(
                    Circle()
                        .stroke(isSelected ? Color.white : Color.clear, lineWidth: 2)
                )
                .overlay(
                    Circle()
                        .stroke(isSelected ? displayColor : Color.clear, lineWidth: 1)
                        .padding(3)
                )
                .shadow(color: isSelected ? displayColor.opacity(0.4) : .clear, radius: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name) color")
    }

    /// Convert a color scale name to a SwiftUI Color using the mid shade from BodyColorScale.
    private func swiftUIColor(for name: String) -> Color {
        guard let scale = BodyColorScale.scales[name] else { return Color.gray }
        return Color(hex: UInt(scale.mid))
    }

    // MARK: - Outfit Section

    @ViewBuilder
    private var outfitSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Outfit")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            outfitPicker(title: "Hat", field: .hat, options: hatOptions,
                         current: evolutionState.userOverrides[.hat] ?? appearance.config.hat)
            outfitPicker(title: "Shirt", field: .shirt, options: shirtOptions,
                         current: evolutionState.userOverrides[.shirt] ?? appearance.config.shirt)
            outfitPicker(title: "Accessory", field: .accessory, options: accessoryOptions,
                         current: evolutionState.userOverrides[.accessory] ?? appearance.config.accessory)
            outfitPicker(title: "Held Item", field: .heldItem, options: heldItemOptions,
                         current: evolutionState.userOverrides[.heldItem] ?? appearance.config.heldItem)
        }
    }

    @ViewBuilder
    private func outfitPicker(title: String, field: AvatarEvolutionState.AppearanceField, options: [String], current: String) -> some View {
        HStack(spacing: VSpacing.sm) {
            lockToggle(field: field)

            Text(title)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(width: 80, alignment: .leading)

            Picker("", selection: Binding(
                get: { current },
                set: { newValue in
                    setOverride(field: field, value: newValue)
                }
            )) {
                ForEach(options, id: \.self) { option in
                    Text(option.replacingOccurrences(of: "_", with: " ").capitalized)
                        .tag(option)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Field Header with Lock

    @ViewBuilder
    private func fieldHeader(title: String, field: AvatarEvolutionState.AppearanceField) -> some View {
        HStack(spacing: VSpacing.sm) {
            lockToggle(field: field)

            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)
        }
    }

    @ViewBuilder
    private func lockToggle(field: AvatarEvolutionState.AppearanceField) -> some View {
        let isLocked = evolutionState.lockedFields.contains(field)
        Button {
            toggleLock(field: field)
        } label: {
            Image(systemName: isLocked ? "lock.fill" : "lock.open")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(isLocked ? VColor.accent : VColor.textMuted)
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isLocked ? "Unlock \(field.rawValue)" : "Lock \(field.rawValue)")
        .help(isLocked ? "Locked: auto-evolution won't change this" : "Unlocked: auto-evolution can change this")
    }

    // MARK: - Reset Button

    @ViewBuilder
    private var resetButton: some View {
        HStack {
            Spacer()
            Button {
                resetToAuto()
            } label: {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 12, weight: .medium))
                    Text("Reset to Auto")
                        .font(VFont.bodyMedium)
                }
                .foregroundColor(VColor.textSecondary)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            Spacer()
        }
        .padding(.top, VSpacing.sm)
    }

    // MARK: - Actions

    /// Set an override value and auto-lock the field.
    private func setOverride(field: AvatarEvolutionState.AppearanceField, value: String) {
        evolutionState.userOverrides[field] = value
        evolutionState.lockedFields.insert(field)
        resolveAndApply()
    }

    /// Toggle lock on a field. Unlocking removes the override so the resolver
    /// falls back to trait-based values and auto-evolution can control the field.
    private func toggleLock(field: AvatarEvolutionState.AppearanceField) {
        if evolutionState.lockedFields.contains(field) {
            evolutionState.lockedFields.remove(field)
            evolutionState.userOverrides.removeValue(forKey: field)
        } else {
            evolutionState.lockedFields.insert(field)
        }
        resolveAndApply()
    }

    /// Clear all overrides and unlock all fields, then re-resolve.
    private func resetToAuto() {
        evolutionState.userOverrides.removeAll()
        evolutionState.lockedFields.removeAll()
        resolveAndApply()
    }

    /// Resolve the current state and apply the result to the appearance manager.
    private func resolveAndApply() {
        let resolved = AvatarEvolutionResolver.resolve(state: evolutionState)
        AvatarAppearanceManager.shared.applyEvolutionResult(resolved)
        evolutionState.save()
    }
}
