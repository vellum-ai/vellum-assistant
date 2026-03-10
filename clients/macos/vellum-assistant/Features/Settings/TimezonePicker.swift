import SwiftUI
import VellumAssistantShared

/// A popover-based timezone picker that shows a searchable list of IANA timezones
/// with a one-click "Use system timezone" option.
struct TimezonePicker: View {
    let onSelect: (String) -> Void
    @State private var searchText = ""

    private static let timezoneEntries: [TimezoneEntry] = {
        TimeZone.knownTimeZoneIdentifiers.sorted().map { identifier in
            let tz = TimeZone(identifier: identifier)!
            let abbreviation = tz.abbreviation() ?? ""
            let offset = tz.formattedUTCOffset()
            let friendlyName = tz.friendlyName()

            // Collect Apple's localized names for richer search coverage
            let locale = Locale(identifier: "en_US")
            let localizedNames = [
                tz.localizedName(for: .standard, locale: locale),
                tz.localizedName(for: .shortStandard, locale: locale),
                tz.localizedName(for: .generic, locale: locale),
                tz.localizedName(for: .shortGeneric, locale: locale),
                tz.localizedName(for: .daylightSaving, locale: locale),
                tz.localizedName(for: .shortDaylightSaving, locale: locale),
            ].compactMap { $0 }

            let aliases = timezoneAliases[identifier] ?? []

            let searchParts = [identifier, friendlyName, abbreviation, offset]
                + localizedNames + aliases
            let searchText = searchParts.joined(separator: " ").lowercased()

            return TimezoneEntry(
                identifier: identifier,
                friendlyName: friendlyName,
                abbreviation: abbreviation,
                offset: offset,
                searchText: searchText
            )
        }
    }()

    private var filteredEntries: [TimezoneEntry] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty {
            return Self.timezoneEntries
        }
        // Tokenized matching: every word in the query must appear somewhere in the search text.
        // This lets queries like "hawaii time" or "eastern us" work naturally.
        let tokens = query.split(separator: " ").map(String.init)
        return Self.timezoneEntries.filter { entry in
            tokens.allSatisfy { token in entry.searchText.contains(token) }
        }
    }

    private var systemTimezoneIdentifier: String {
        TimeZone.current.identifier
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Search field
            HStack(spacing: VSpacing.sm) {
                VIconView(.search, size: 12)
                    .foregroundColor(VColor.textMuted)
                TextField("Search timezones...", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        VIconView(.circleX, size: 12)
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.inputBackground)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
            .padding(.horizontal, VSpacing.md)
            .padding(.top, VSpacing.md)
            .padding(.bottom, VSpacing.sm)

            // "Use system timezone" button
            Button {
                onSelect(systemTimezoneIdentifier)
            } label: {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.monitor, size: 12)
                        .foregroundColor(VColor.accent)
                    Text("Use system: \(systemTimezoneIdentifier)")
                        .font(VFont.body)
                        .foregroundColor(VColor.accent)
                    Spacer()
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(Color.clear)
            .pointerCursor()

            Divider()
                .background(VColor.surfaceBorder)
                .padding(.horizontal, VSpacing.md)

            // Scrollable timezone list
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(filteredEntries, id: \.identifier) { entry in
                        Button {
                            onSelect(entry.identifier)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(entry.identifier)
                                        .font(VFont.body)
                                        .foregroundColor(VColor.textPrimary)
                                    if !entry.friendlyName.isEmpty {
                                        Text("\(entry.friendlyName) (\(entry.offset))")
                                            .font(VFont.caption)
                                            .foregroundColor(VColor.textMuted)
                                    }
                                }
                                Spacer()
                            }
                            .padding(.horizontal, VSpacing.md)
                            .padding(.vertical, VSpacing.xs)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .pointerCursor()
                    }

                    if filteredEntries.isEmpty {
                        Text("No matching timezones")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textMuted)
                            .padding(.horizontal, VSpacing.md)
                            .padding(.vertical, VSpacing.md)
                    }
                }
            }
            .frame(maxHeight: 300)
        }
        .frame(width: 320)
        .background(VColor.surface)
    }
}

// MARK: - Supporting Types

private struct TimezoneEntry {
    let identifier: String
    let friendlyName: String
    let abbreviation: String
    let offset: String
    let searchText: String
}

// MARK: - Timezone Search Aliases

/// Maps IANA timezone identifiers to additional search terms that Apple's localized names don't cover.
/// Covers country names, state/province names, common city aliases, and colloquial references.
private let timezoneAliases: [String: [String]] = [
    // United States
    "America/New_York": ["usa", "united states", "new york", "nyc", "florida", "georgia", "virginia",
                         "massachusetts", "boston", "miami", "atlanta", "philadelphia", "dc",
                         "washington dc", "carolina", "connecticut", "maine", "vermont", "maryland"],
    "America/Chicago": ["usa", "united states", "texas", "illinois", "dallas", "houston",
                        "minneapolis", "milwaukee", "nashville", "memphis", "kansas city",
                        "san antonio", "louisiana", "new orleans", "wisconsin", "minnesota",
                        "iowa", "missouri", "tennessee", "alabama", "mississippi", "oklahoma",
                        "nebraska", "arkansas"],
    "America/Denver": ["usa", "united states", "colorado", "utah", "montana", "wyoming",
                       "new mexico", "salt lake city", "albuquerque", "boise", "idaho"],
    "America/Los_Angeles": ["usa", "united states", "california", "la", "san francisco",
                            "sf", "seattle", "portland", "washington state", "oregon", "nevada",
                            "las vegas", "san diego", "silicon valley", "hollywood", "pst", "pdt"],
    "America/Anchorage": ["usa", "united states", "alaska"],
    "Pacific/Honolulu": ["usa", "united states", "hawaii", "oahu", "maui", "kauai", "waikiki"],
    "America/Phoenix": ["usa", "united states", "arizona"],

    // Canada
    "America/Toronto": ["canada", "ontario"],
    "America/Vancouver": ["canada", "british columbia", "bc"],
    "America/Edmonton": ["canada", "alberta", "calgary"],
    "America/Winnipeg": ["canada", "manitoba"],
    "America/Halifax": ["canada", "nova scotia", "new brunswick", "atlantic canada"],
    "America/St_Johns": ["canada", "newfoundland"],

    // Europe
    "Europe/London": ["uk", "united kingdom", "england", "britain", "great britain", "scotland",
                      "wales", "northern ireland"],
    "Europe/Paris": ["france"],
    "Europe/Berlin": ["germany", "deutschland"],
    "Europe/Madrid": ["spain", "espana"],
    "Europe/Rome": ["italy", "italia"],
    "Europe/Amsterdam": ["netherlands", "holland"],
    "Europe/Brussels": ["belgium"],
    "Europe/Zurich": ["switzerland"],
    "Europe/Vienna": ["austria"],
    "Europe/Stockholm": ["sweden"],
    "Europe/Oslo": ["norway"],
    "Europe/Copenhagen": ["denmark"],
    "Europe/Helsinki": ["finland"],
    "Europe/Warsaw": ["poland"],
    "Europe/Prague": ["czech republic", "czechia"],
    "Europe/Dublin": ["ireland"],
    "Europe/Lisbon": ["portugal"],
    "Europe/Athens": ["greece"],
    "Europe/Bucharest": ["romania"],
    "Europe/Istanbul": ["turkey", "turkiye"],
    "Europe/Moscow": ["russia"],
    "Europe/Kiev": ["ukraine", "kyiv"],

    // Asia
    "Asia/Tokyo": ["japan"],
    "Asia/Shanghai": ["china", "beijing", "prc"],
    "Asia/Hong_Kong": ["hong kong", "hk"],
    "Asia/Singapore": ["singapore"],
    "Asia/Kolkata": ["india", "mumbai", "delhi", "bangalore", "chennai", "hyderabad"],
    "Asia/Seoul": ["south korea", "korea"],
    "Asia/Taipei": ["taiwan"],
    "Asia/Bangkok": ["thailand"],
    "Asia/Jakarta": ["indonesia"],
    "Asia/Manila": ["philippines"],
    "Asia/Ho_Chi_Minh": ["vietnam", "saigon"],
    "Asia/Kuala_Lumpur": ["malaysia"],
    "Asia/Dubai": ["uae", "united arab emirates", "abu dhabi"],
    "Asia/Riyadh": ["saudi arabia"],
    "Asia/Karachi": ["pakistan"],
    "Asia/Dhaka": ["bangladesh"],
    "Asia/Colombo": ["sri lanka"],
    "Asia/Kathmandu": ["nepal"],
    "Asia/Tashkent": ["uzbekistan"],
    "Asia/Almaty": ["kazakhstan"],
    "Asia/Tehran": ["iran"],
    "Asia/Baghdad": ["iraq"],
    "Asia/Beirut": ["lebanon"],
    "Asia/Jerusalem": ["israel"],

    // Oceania
    "Australia/Sydney": ["australia", "aest", "new south wales", "nsw"],
    "Australia/Melbourne": ["australia", "victoria"],
    "Australia/Brisbane": ["australia", "queensland"],
    "Australia/Perth": ["australia", "western australia"],
    "Australia/Adelaide": ["australia", "south australia"],
    "Australia/Darwin": ["australia", "northern territory"],
    "Australia/Hobart": ["australia", "tasmania"],
    "Pacific/Auckland": ["new zealand", "nz", "nzst"],
    "Pacific/Fiji": ["fiji"],

    // South America
    "America/Sao_Paulo": ["brazil", "brasil"],
    "America/Argentina/Buenos_Aires": ["argentina"],
    "America/Santiago": ["chile"],
    "America/Bogota": ["colombia"],
    "America/Lima": ["peru"],
    "America/Caracas": ["venezuela"],
    "America/Montevideo": ["uruguay"],

    // Central America & Caribbean
    "America/Mexico_City": ["mexico"],
    "America/Costa_Rica": ["costa rica"],
    "America/Panama": ["panama"],

    // Africa
    "Africa/Cairo": ["egypt"],
    "Africa/Lagos": ["nigeria"],
    "Africa/Johannesburg": ["south africa"],
    "Africa/Nairobi": ["kenya"],
    "Africa/Casablanca": ["morocco"],
    "Africa/Accra": ["ghana"],
    "Africa/Addis_Ababa": ["ethiopia"],
    "Africa/Dar_es_Salaam": ["tanzania"],
]

// MARK: - TimeZone Helpers

private extension TimeZone {
    /// Returns a human-readable name derived from the IANA identifier.
    /// e.g. "America/New_York" → "New York", "Europe/London" → "London"
    func friendlyName() -> String {
        let parts = identifier.split(separator: "/")
        guard let city = parts.last else { return "" }
        return city.replacingOccurrences(of: "_", with: " ")
    }

    /// Returns a formatted UTC offset string like "UTC-5" or "UTC+5:30".
    func formattedUTCOffset() -> String {
        let seconds = secondsFromGMT()
        if seconds == 0 { return "UTC" }
        let hours = seconds / 3600
        let minutes = abs(seconds) % 3600 / 60
        let sign = hours >= 0 ? "+" : ""
        if minutes == 0 {
            return "UTC\(sign)\(hours)"
        }
        return "UTC\(sign)\(hours):\(String(format: "%02d", minutes))"
    }
}
