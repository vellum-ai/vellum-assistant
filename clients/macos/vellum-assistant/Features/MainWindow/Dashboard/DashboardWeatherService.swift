import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "WeatherService")

/// Simple weather data model for the dashboard card.
struct WeatherData: Equatable {
    let location: String
    let temperature: String
    let condition: String
    let conditionEmoji: String
}

/// Fetches weather data for the dashboard. Uses the Open-Meteo API (no API key required)
/// with a hardcoded fallback location of Palo Alto, CA. The actual locale will come from
/// USER.md memory in the future.
@MainActor
final class DashboardWeatherService: ObservableObject {
    @Published var weather: WeatherData?
    @Published var isLoading = false

    private var lastFetchDate: Date?
    /// Minimum interval between fetches (15 minutes).
    private let fetchInterval: TimeInterval = 900

    /// Palo Alto, CA coordinates (fallback).
    private let defaultLatitude = 37.4419
    private let defaultLongitude = -122.1430
    private let defaultLocation = "Palo Alto, CA"

    func fetchIfNeeded() {
        if let lastFetch = lastFetchDate, Date().timeIntervalSince(lastFetch) < fetchInterval {
            return
        }
        fetch()
    }

    func fetch() {
        guard !isLoading else { return }
        isLoading = true

        Task {
            do {
                let data = try await fetchWeather()
                self.weather = data
                self.lastFetchDate = Date()
            } catch {
                log.warning("Weather fetch failed: \(error.localizedDescription)")
                // Use placeholder data on failure
                self.weather = WeatherData(
                    location: defaultLocation,
                    temperature: "--",
                    condition: "Unavailable",
                    conditionEmoji: "\u{2601}\u{FE0F}"
                )
            }
            self.isLoading = false
        }
    }

    private func fetchWeather() async throws -> WeatherData {
        let urlString = "https://api.open-meteo.com/v1/forecast?latitude=\(defaultLatitude)&longitude=\(defaultLongitude)&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto"
        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }

        let (data, _) = try await URLSession.shared.data(from: url)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        guard let current = json?["current"] as? [String: Any],
              let temp = current["temperature_2m"] as? Double,
              let weatherCode = current["weather_code"] as? Int else {
            throw URLError(.cannotParseResponse)
        }

        let (condition, emoji) = Self.decodeWeatherCode(weatherCode)
        return WeatherData(
            location: defaultLocation,
            temperature: "\(Int(temp.rounded()))\u{00B0}F",
            condition: condition,
            conditionEmoji: emoji
        )
    }

    /// Decode WMO weather code to human-readable condition and emoji.
    private static func decodeWeatherCode(_ code: Int) -> (String, String) {
        switch code {
        case 0: return ("Clear sky", "\u{2600}\u{FE0F}")
        case 1: return ("Mainly clear", "\u{1F324}\u{FE0F}")
        case 2: return ("Partly cloudy", "\u{26C5}")
        case 3: return ("Overcast", "\u{2601}\u{FE0F}")
        case 45, 48: return ("Foggy", "\u{1F32B}\u{FE0F}")
        case 51, 53, 55: return ("Drizzle", "\u{1F326}\u{FE0F}")
        case 61, 63, 65: return ("Rain", "\u{1F327}\u{FE0F}")
        case 66, 67: return ("Freezing rain", "\u{1F327}\u{FE0F}")
        case 71, 73, 75: return ("Snow", "\u{1F328}\u{FE0F}")
        case 77: return ("Snow grains", "\u{1F328}\u{FE0F}")
        case 80, 81, 82: return ("Showers", "\u{1F326}\u{FE0F}")
        case 85, 86: return ("Snow showers", "\u{1F328}\u{FE0F}")
        case 95: return ("Thunderstorm", "\u{26C8}\u{FE0F}")
        case 96, 99: return ("Thunderstorm with hail", "\u{26C8}\u{FE0F}")
        default: return ("Unknown", "\u{1F324}\u{FE0F}")
        }
    }
}
