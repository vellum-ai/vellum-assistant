import Foundation

/// Per-event sound configuration. `sounds` is a pool of filenames in the sounds
/// directory (e.g., "Gentle Ding.aiff"); an empty pool means use the default blip.
/// Display label is the filename minus its extension.
struct SoundEventConfig: Equatable {
    var enabled: Bool
    var sounds: [String]

    init(enabled: Bool, sounds: [String] = []) {
        self.enabled = enabled
        self.sounds = sounds
    }

    /// Compatibility shim — new code should read/write `sounds` directly.
    /// Scheduled for removal once all consumers migrate.
    ///
    /// Getter returns the first entry in the pool (or `nil` when empty).
    /// Setter replaces the pool: a non-empty string becomes a single-entry pool,
    /// `nil` or empty string clears the pool.
    var sound: String? {
        get { sounds.first }
        set {
            if let newValue, !newValue.isEmpty {
                sounds = [newValue]
            } else {
                sounds = []
            }
        }
    }
}

extension SoundEventConfig: Codable {
    enum CodingKeys: String, CodingKey {
        case enabled
        case sounds
        case sound
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Match the forgiving JSON loader in `SoundManager.fetchConfig()` — missing
        // `enabled` keys default to `false` rather than failing the decode.
        let enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false

        let decodedSounds: [String]
        if let pool = try container.decodeIfPresent([String].self, forKey: .sounds) {
            decodedSounds = pool
        } else if let legacy = try container.decodeIfPresent(String.self, forKey: .sound) {
            decodedSounds = [legacy]
        } else {
            decodedSounds = []
        }

        // Defensively drop empty entries so a malformed pool never hits playback.
        self.enabled = enabled
        self.sounds = decodedSounds.filter { !$0.isEmpty }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(sounds, forKey: .sounds)
        // New writes are always in the new shape — the app and config ship
        // together, so there are no pre-PR-1 readers in the wild to cater to.
    }
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
            events[event.rawValue] = SoundEventConfig(enabled: false, sounds: [])
        }
        return SoundsConfig(
            globalEnabled: false,
            volume: 0.7,
            events: events
        )
    }

    /// Returns the configuration for a specific event, falling back to disabled with an empty pool
    /// if the event is not present in the dictionary.
    func config(for event: SoundEvent) -> SoundEventConfig {
        events[event.rawValue] ?? SoundEventConfig(enabled: false, sounds: [])
    }
}
