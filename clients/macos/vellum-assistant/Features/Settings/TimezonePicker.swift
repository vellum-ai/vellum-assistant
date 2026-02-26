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
            return TimezoneEntry(
                identifier: identifier,
                friendlyName: friendlyName,
                abbreviation: abbreviation,
                offset: offset,
                searchText: "\(identifier) \(friendlyName) \(abbreviation)".lowercased()
            )
        }
    }()

    private var filteredEntries: [TimezoneEntry] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty {
            return Self.timezoneEntries
        }
        return Self.timezoneEntries.filter { $0.searchText.contains(query) }
    }

    private var systemTimezoneIdentifier: String {
        TimeZone.current.identifier
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Search field
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(VColor.textMuted)
                    .font(.system(size: 12))
                TextField("Search timezones...", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12))
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
                    Image(systemName: "desktopcomputer")
                        .foregroundColor(VColor.accent)
                        .font(.system(size: 12))
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
            .onHover { hovering in
                if hovering {
                    NSCursor.pointingHand.push()
                } else {
                    NSCursor.pop()
                }
            }

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
                        .onHover { hovering in
                            if hovering {
                                NSCursor.pointingHand.push()
                            } else {
                                NSCursor.pop()
                            }
                        }
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
