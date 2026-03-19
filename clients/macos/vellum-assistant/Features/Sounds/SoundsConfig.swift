import Foundation

/// Per-event sound configuration. `sound` is a filename in the sounds directory
/// (e.g., "Gentle Ding.aiff"); nil means use the default blip.
/// Display label is the filename minus its extension.
struct SoundEventConfig: Codable, Equatable {
    var enabled: Bool
    var sound: String?
}

/// Top-level sound configuration persisted as JSON.
/// Keys in `events` are `SoundEvent` raw values.
struct SoundsConfig: Codable, Equatable {
    var globalEnabled: Bool
    var volume: Float
    var events: [String: SoundEventConfig]

    /// Default configuration: all events disabled, no custom sounds, volume at 70%.
    static var defaultConfig: SoundsConfig {
        var events: [String: SoundEventConfig] = [:]
        for event in SoundEvent.allCases {
            events[event.rawValue] = SoundEventConfig(enabled: false, sound: nil)
        }
        return SoundsConfig(
            globalEnabled: false,
            volume: 0.7,
            events: events
        )
    }

    /// Returns the configuration for a specific event, falling back to disabled with default sound
    /// if the event is not present in the dictionary.
    func config(for event: SoundEvent) -> SoundEventConfig {
        events[event.rawValue] ?? SoundEventConfig(enabled: false, sound: nil)
    }
}
