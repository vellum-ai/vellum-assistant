import Foundation
import Observation
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MeetStatusPanel")

// MARK: - View Model

/// Observable view model that tracks the live state of the Meet bot by
/// consuming `meet.*` SSE events from the shared `ServerMessage` stream.
///
/// Exposed as a single-panel model rather than a per-conversation one because
/// the bot can run independently of any conversation focus (the Home gallery
/// simply shows "in meeting" at the top whenever the bot is live). If the
/// daemon grows support for concurrent meetings later, the state machine can
/// graduate to a keyed dictionary without changing callers.
///
/// The state transitions are driven purely by events:
/// - `meet.joining` → `.joining(meetingId, url)`
/// - `meet.joined`  → `.joined(meetingId, title, joinedAt = now)`. When a
///   preceding `meet.joining` is present for the same meeting, the joining
///   URL is carried forward as the title. When `meet.joined` arrives without
///   a prior `meet.joining` (e.g. the client reconnected its SSE stream
///   mid-meeting), we still transition to `.joined` but use the meetingId as
///   the title fallback — the daemon does not republish `meet.joining` on
///   reconnect, so gating on it would leave the panel blank while the bot is
///   demonstrably live.
/// - `meet.error`   → `.error(reason)`
/// - `meet.left`    → `.idle` (any in-flight state collapses to idle)
///
/// Out-of-order `meet.left` with no in-flight state is a no-op — if `.left`
/// fires while idle, the meeting is over and there is nothing to render.
@MainActor
@Observable
public final class MeetStatusViewModel {

    /// Top-level display state for the panel. The view maps each case to a
    /// specific layout — `idle` collapses the panel to `EmptyView`.
    public enum State: Equatable {
        case idle
        case joining(meetingId: String, url: String)
        case joined(meetingId: String, title: String, joinedAt: Date)
        case error(reason: String)
    }

    public private(set) var state: State = .idle

    // MARK: - Non-reactive bookkeeping

    @ObservationIgnored private let messageStream: AsyncStream<ServerMessage>
    @ObservationIgnored private var sseTask: Task<Void, Never>?
    /// Clock injected so tests can drive deterministic `joinedAt` values.
    @ObservationIgnored private let clock: @Sendable () -> Date

    // MARK: - Lifecycle

    public init(
        messageStream: AsyncStream<ServerMessage>,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.messageStream = messageStream
        self.clock = clock
        startListening()
    }

    deinit {
        sseTask?.cancel()
    }

    // MARK: - Event intake

    /// Applies a single SSE event to the state machine. Exposed so unit tests
    /// can drive state transitions directly without going through the stream.
    public func handle(_ message: ServerMessage) {
        switch message {
        case .meetJoining(let m):
            state = .joining(meetingId: m.meetingId, url: m.url)

        case .meetJoined(let m):
            // Carry the joining URL forward as the title when we saw a
            // matching `meet.joining` for this meeting. Otherwise this is
            // either a reconnect (the SSE stream dropped and resubscribed
            // mid-meeting, so the daemon has already published `meet.joining`
            // and will not republish it) or an event we observed before the
            // view model was constructed. In both cases the bot is live, so
            // we must transition into `.joined` anyway — using the meetingId
            // as a title fallback until a later event populates real data.
            let title: String
            if case let .joining(existingId, url) = state, existingId == m.meetingId {
                title = url
            } else {
                log.debug("meet.joined without preceding meet.joining — using meetingId as title fallback: \(m.meetingId, privacy: .public)")
                title = m.meetingId
            }
            state = .joined(
                meetingId: m.meetingId,
                title: title,
                joinedAt: clock()
            )

        case .meetError(let m):
            state = .error(reason: m.detail)

        case .meetLeft:
            state = .idle

        default:
            break
        }
    }

    // MARK: - SSE subscription

    private func startListening() {
        let stream = self.messageStream
        sseTask = Task { [weak self] in
            for await message in stream {
                if Task.isCancelled { break }
                guard let self else { break }
                self.handle(message)
            }
        }
    }
}

// MARK: - View

/// Status panel rendered at the top of the Home gallery.
///
/// - When the bot is idle, returns `EmptyView` so the panel is invisible.
/// - When joining, shows "Joining meeting…" with the URL.
/// - When joined, shows "In meeting" plus a live, `TimelineView`-driven
///   elapsed clock. The clock is driven by `.periodic(from:by:)` rather than
///   an explicit `Timer` so SwiftUI can throttle redraws and we don't hold a
///   manual timer on the view model.
/// - When errored, shows the error detail in the negative accent color.
public struct MeetStatusPanel: View {
    @Bindable public var viewModel: MeetStatusViewModel

    public init(viewModel: MeetStatusViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        Group {
            switch viewModel.state {
            case .idle:
                EmptyView()

            case .joining(_, let url):
                row(
                    title: "Joining meeting…",
                    subtitle: url,
                    trailing: nil,
                    tint: VColor.contentSecondary
                )

            case .joined(_, let title, let joinedAt):
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    row(
                        title: "In meeting",
                        subtitle: title,
                        trailing: Self.formatElapsed(from: joinedAt, now: context.date),
                        tint: VColor.systemPositiveStrong
                    )
                }

            case .error(let reason):
                row(
                    title: "Meeting error",
                    subtitle: reason,
                    trailing: nil,
                    tint: VColor.systemNegativeStrong
                )
            }
        }
        .animation(VAnimation.standard, value: stateKey)
        .accessibilityElement(children: .combine)
    }

    // Stable, hashable discriminator of the panel's presentation so the
    // animation only fires on logical transitions — not on every TimelineView
    // tick within the `.joined` state.
    private var stateKey: String {
        switch viewModel.state {
        case .idle: return "idle"
        case .joining(let id, _): return "joining:\(id)"
        case .joined(let id, _, _): return "joined:\(id)"
        case .error: return "error"
        }
    }

    @ViewBuilder
    private func row(
        title: String,
        subtitle: String,
        trailing: String?,
        tint: Color
    ) -> some View {
        HStack(spacing: VSpacing.md) {
            Circle()
                .fill(tint)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                Text(subtitle)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: VSpacing.md)

            if let trailing {
                Text(trailing)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .monospacedDigit()
            }
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: VSpacing.md, trailing: VSpacing.lg))
        .background {
            RoundedRectangle(cornerRadius: VRadius.window, style: .continuous)
                .fill(VColor.surfaceOverlay)
        }
    }

    // MARK: - Helpers

    /// Formats the elapsed interval between `start` and `now` as mm:ss, or
    /// h:mm:ss once the meeting crosses the one-hour mark. Negative deltas
    /// clamp to `0:00` so a clock-skewed `joinedAt` never produces garbage.
    static func formatElapsed(from start: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        let s = seconds % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%d:%02d", m, s)
    }
}
