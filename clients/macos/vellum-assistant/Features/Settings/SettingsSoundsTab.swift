import AppKit
import SwiftUI
import VellumAssistantShared

/// Settings tab for configuring sound effects — global toggle, volume, and per-event sound selection.
struct SettingsSoundsTab: View {
    /// The sound manager singleton provides config, playback, and available sounds.
    private var soundManager: SoundManager { SoundManager.shared }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            globalSoundSection
            eventSoundSection
            helperTextSection
        }
    }

    // MARK: - Global Section

    private var globalSoundSection: some View {
        SettingsCard(title: "Sound Effects") {
            VToggle(
                isOn: Binding(
                    get: { soundManager.config.globalEnabled },
                    set: { newValue in
                        var updated = soundManager.config
                        updated.globalEnabled = newValue
                        soundManager.saveConfig(updated)
                    }
                ),
                label: "Enable sound effects"
            )

            SettingsDivider()

            HStack(spacing: VSpacing.md) {
                Text("Volume")
                    .font(VFont.body)
                    .foregroundColor(soundManager.config.globalEnabled ? VColor.contentSecondary : VColor.contentDisabled)

                VSlider(
                    value: Binding(
                        get: { Double(soundManager.config.volume) },
                        set: { newValue in
                            var updated = soundManager.config
                            updated.volume = Float(newValue)
                            soundManager.saveConfig(updated)
                        }
                    ),
                    range: 0...1,
                    step: 0.05
                )
                .frame(maxWidth: 200)
            }
            .disabled(!soundManager.config.globalEnabled)

            SettingsDivider()

            VButton(
                label: "Preview",
                leftIcon: VIcon.play.rawValue,
                style: .outlined
            ) {
                previewDefaultBlip()
            }
        }
    }

    // MARK: - Per-Event Section

    private var eventSoundSection: some View {
        SettingsCard(title: "Sound Events") {
            let events = SoundEvent.allCases
            ForEach(Array(events.enumerated()), id: \.element) { index, event in
                if index > 0 {
                    SettingsDivider()
                }
                soundEventRow(for: event)
            }
        }
        .disabled(!soundManager.config.globalEnabled)
    }

    @ViewBuilder
    private func soundEventRow(for event: SoundEvent) -> some View {
        let eventConfig = soundManager.config.config(for: event)
        let sounds = soundManager.availableSounds()

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .center) {
                Text(event.displayName)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                Spacer()

                VToggle(
                    isOn: Binding(
                        get: { eventConfig.enabled },
                        set: { newValue in
                            var updated = soundManager.config
                            var ec = updated.config(for: event)
                            ec.enabled = newValue
                            updated.events[event.rawValue] = ec
                            soundManager.saveConfig(updated)
                        }
                    )
                )
            }

            HStack(spacing: VSpacing.sm) {
                soundPicker(for: event, eventConfig: eventConfig, sounds: sounds)

                VButton(
                    label: "Preview sound",
                    iconOnly: VIcon.play.rawValue,
                    style: .ghost,
                    tooltip: "Preview sound"
                ) {
                    previewSound(for: event, eventConfig: eventConfig)
                }
                .disabled(!eventConfig.enabled)
            }
            .disabled(!eventConfig.enabled)
        }
        .padding(.vertical, VSpacing.xs)
    }

    @ViewBuilder
    private func soundPicker(
        for event: SoundEvent,
        eventConfig: SoundEventConfig,
        sounds: [(label: String, filename: String)]
    ) -> some View {
        // We use an optional String binding where nil means "Default Blip".
        // VDropdown needs a Hashable selection, so we use "" as the sentinel for default.
        let selectedFilename = eventConfig.sound ?? ""

        let options: [(label: String, value: String)] = [
            (label: "Default Blip", value: "")
        ] + sounds.map { (label: $0.label, value: $0.filename) }

        VDropdown(
            placeholder: "Default Blip",
            selection: Binding(
                get: { selectedFilename },
                set: { newValue in
                    var updated = soundManager.config
                    var ec = updated.config(for: event)
                    ec.sound = newValue.isEmpty ? nil : newValue
                    updated.events[event.rawValue] = ec
                    soundManager.saveConfig(updated)
                }
            ),
            options: options,
            maxWidth: 220
        )
    }

    // MARK: - Helper Text

    private var helperTextSection: some View {
        Text("Send your assistant a sound file or ask it to customize your sounds")
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)
    }

    // MARK: - Playback

    /// Preview the default blip at the current volume, bypassing enabled checks.
    private func previewDefaultBlip() {
        soundManager.previewDefaultBlip()
    }

    /// Preview the sound configured for a specific event, delegating to
    /// SoundManager which uses the instance-aware sounds directory.
    private func previewSound(for event: SoundEvent, eventConfig: SoundEventConfig) {
        soundManager.previewSound(for: event)
    }
}
