import type { Meta, StoryObj } from "@storybook/react-vite";

import { CatchUpWidgetPreview } from "./catch-up-widget-preview";
import { ReplicaNotice } from "./replica-notice";
import { QuickActionsWidgetPreview } from "./quick-actions-widget-preview";
import { StatusWidgetPreview } from "./status-widget-preview";
import { VellumAppIconMark } from "./vellum-app-icon-mark";
import type { WidgetAppearance } from "./widget-tokens";

/**
 * # iOS Home Screen widgets
 *
 * Replicas of the three WidgetKit widgets in
 * `clients/ios/App/VoiceActivity/Widgets/`, so their states can be reviewed in
 * a browser instead of a simulator.
 *
 * ## What this is not
 *
 * These are not the widgets. The widgets are SwiftUI compiled into an iOS app
 * extension, and nothing renders SwiftUI in Storybook. What is here is a
 * hand-maintained copy that reads its palette and geometry from constants
 * transcribed out of the Swift, and it is worth exactly as much as that copy is
 * current. Three specific gaps to keep in mind:
 *
 * - **The symbols are stand-ins.** The cards draw SF Symbols
 *   (`camera.fill`, `waveform`, `bubble.left`, `ellipsis`) and the `VellumV`
 *   asset, none of which exist in a browser. Everything else is an
 *   approximation at the same nominal point size. The eyes are the exception:
 *   they carry the same Bezier control points, and were checked against a
 *   SwiftUI render of the real shapes at 8x, where the sclera and pupil ink
 *   agree to 0.00pt on every edge.
 * - **The type is not SF Pro off an Apple device.** The font stack falls
 *   through to whatever the browser has, so line metrics drift. Judge layout
 *   and weight here, not kerning.
 * - **Flattened mode is imitated, not applied.** On a themed Home Screen
 *   WidgetKit discards every color and redraws the widget in two monochrome
 *   groups from each view's alpha. The `flattened` arg paints what that
 *   *should* come out as. Only a device proves it.
 *
 * The authoritative previews are the `#Preview` blocks in the Swift, which
 * render the real views in Xcode. Use these for design review and sharing; use
 * those before believing anything.
 */
const meta = {
  title: "iOS Widgets/Home Screen",
  parameters: { layout: "centered" },
  // Every canvas, not only the Docs tab: cards that look this much like the
  // real thing are the ones worth labelling where they are looked at.
  decorators: [
    (Story) => (
      <div>
        <ReplicaNotice />
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

const AVATAR_PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#F2994A"/><stop offset="100%" stop-color="#9B51E0"/>
      </linearGradient></defs>
      <rect width="120" height="120" fill="url(#g)"/>
      <circle cx="60" cy="46" r="22" fill="#FFFFFF" fill-opacity="0.85"/>
      <path d="M18 120c0-23 19-38 42-38s42 15 42 38Z" fill="#FFFFFF" fill-opacity="0.85"/>
    </svg>`,
  );

const CONVERSATIONS = [
  {
    id: "1",
    title: "Weekend Priority Sorting",
    subtitle: "Recents",
    hasUnseen: true,
  },
  {
    id: "2",
    title: "Q3 planning doc review",
    subtitle: "Work",
    isProcessing: true,
  },
  { id: "3", title: "Flight options to Lisbon", subtitle: "Travel" },
];

/**
 * Both appearances side by side. A widget is drawn in whatever appearance the
 * device is in, so every card carries a dark variant and neither is the
 * default.
 */
function Appearances({
  render,
}: {
  render: (appearance: WidgetAppearance) => React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      {(["light", "dark"] as const).map((appearance) => (
        <div
          key={appearance}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: "center",
            padding: 20,
            borderRadius: 20,
            background: appearance === "light" ? "#E7E4DF" : "#2A2A2E",
          }}
        >
          {render(appearance)}
          <span
            style={{
              fontSize: 11,
              color: appearance === "light" ? "#5A5A5A" : "#B0B0B0",
            }}
          >
            {appearance}
          </span>
        </div>
      ))}
    </div>
  );
}

type Story = StoryObj;

/**
 * Nothing waiting. The face is the account's avatar rather than a
 * notification, so the card wears it whatever the snapshot says, resting a
 * nudge right of centre to lean into the glance the pupils already have.
 */
export const QuickActionsQuiet: Story = {
  name: "Quick Actions / quiet",
  render: () => (
    <Appearances
      render={(appearance) => (
        <QuickActionsWidgetPreview appearance={appearance} />
      )}
    />
  ),
};

/**
 * With a count. The mark moves to the leading margin to leave the chip the
 * other end of the row, and wide counts buy their width from the eyes rather
 * than compressing the row.
 *
 * The chip is a tap target on the device: it runs `OpenConversationsIntent`
 * and lands on the conversation list.
 */
export const QuickActionsUnread: Story = {
  name: "Quick Actions / unread",
  render: () => (
    <Appearances
      render={(appearance) => (
        <div style={{ display: "flex", gap: 12 }}>
          <QuickActionsWidgetPreview appearance={appearance} unreadCount={3} />
          <QuickActionsWidgetPreview
            appearance={appearance}
            unreadCount={128}
            accentHex="#F2C94C"
          />
        </div>
      )}
    />
  ),
};

/**
 * The three avatar kinds, which is what decides the treatment: a photo has no
 * accent by design, so it replaces the eyes and is blurred under a scrim to
 * become the card, while an account with no avatar at all falls back to the
 * brand block.
 *
 * The character in the middle carries a face raster alongside its accent,
 * which production payloads do. It keeps its accent and its eyes: presence of
 * a raster is not what makes a card a photo card.
 *
 * Quiet cards, because that is where the mark is drawn full size and where its
 * placement shows: the eyes rest a nudge right of centre, leaning into the
 * glance their pupils already have, while a photo sits on the line. A photo has
 * no glance to lean into, and the same nudge only reads as a square hung
 * crooked.
 */
export const QuickActionsAvatars: Story = {
  name: "Quick Actions / avatar kinds",
  render: () => (
    <Appearances
      render={(appearance) => (
        <div style={{ display: "flex", gap: 12 }}>
          <QuickActionsWidgetPreview
            appearance={appearance}
            avatarKind="image"
            accentHex={null}
            avatarImageUrl={AVATAR_PHOTO}
          />
          <QuickActionsWidgetPreview
            appearance={appearance}
            avatarKind="character"
            accentHex="#0E9B8B"
            avatarImageUrl={AVATAR_PHOTO}
          />
          <QuickActionsWidgetPreview
            appearance={appearance}
            avatarKind="none"
            accentHex={null}
          />
        </div>
      )}
    />
  ),
};

/**
 * A snapshot's ordinary `unreadCount: 0` is the quiet card, not a chip reading
 * zero, so a consumer can hand the real count straight over.
 */
export const QuickActionsZeroUnread: Story = {
  name: "Quick Actions / zero unread",
  render: () => (
    <Appearances
      render={(appearance) => (
        <QuickActionsWidgetPreview appearance={appearance} unreadCount={0} />
      )}
    />
  ),
};

/**
 * The launcher and the readout. A count is worth the card only while there is
 * a count, so the card flips rather than printing "All caught up." over two
 * buttons.
 *
 * On the readout, the unread line is a tap target and the in-progress line
 * deliberately is not: it counts turns still running, not replies waiting, so
 * the conversation list is not where following it would go.
 */
export const StatusStates: Story = {
  name: "Status / idle and active",
  render: () => (
    <Appearances
      render={(appearance) => (
        <div style={{ display: "flex", gap: 12 }}>
          <StatusWidgetPreview appearance={appearance} />
          <StatusWidgetPreview
            appearance={appearance}
            unreadCount={3}
            inProgressCount={2}
          />
        </div>
      )}
    />
  ),
};

/**
 * The mark the New Chat surfaces fall back to when no avatar has synced, which
 * is the state the widget gallery renders on the Add Widget sheet.
 *
 * It is the containing app's icon, and the three builds do not ship the same
 * one: a Dev widget advertising the production green would be advertising an
 * icon that build does not have. On the device the ground comes from the
 * running bundle; here it is an arg.
 *
 * The eyes are the avatar library's `quirky` style, the same geometry the icon
 * bundles embed. They are deliberately not the widget's own eyes, which are a
 * wider, rounder pair and read as a different face.
 */
export const AppIconMark: Story = {
  name: "App icon mark / per build",
  render: () => (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <VellumAppIconMark size={72} environment="production" />
      <VellumAppIconMark size={72} environment="staging" />
      <VellumAppIconMark size={72} environment="dev" />
      <span style={{ background: "#141416", padding: 12, borderRadius: 14 }}>
        <VellumAppIconMark size={72} flattened />
      </span>
    </div>
  ),
};

/**
 * What the small cards do once the snapshot is too old to be counting with.
 *
 * Quick Actions drops the chip and keeps the face, so the card is
 * indistinguishable from a quiet one: the tally is a claim about now, which is
 * exactly what a closed app cannot see, while whose assistant this is stays
 * true. Status drops the readout entirely, because a lone "3 unread" also
 * asserts nothing is running, and the launcher is the more useful true thing.
 */
export const StaleSnapshots: Story = {
  name: "Stale snapshot",
  render: () => (
    <Appearances
      render={(appearance) => (
        <div style={{ display: "flex", gap: 12 }}>
          <QuickActionsWidgetPreview
            appearance={appearance}
            unreadCount={3}
            isStale
          />
          <StatusWidgetPreview
            appearance={appearance}
            unreadCount={3}
            inProgressCount={2}
            isStale
          />
        </div>
      )}
    />
  ),
};

/** Rows with a group, a turn in flight, and something unread. */
export const CatchUpRows: Story = {
  name: "Catch Up / rows",
  render: () => (
    <Appearances
      render={(appearance) => (
        <CatchUpWidgetPreview
          appearance={appearance}
          conversations={CONVERSATIONS}
        />
      )}
    />
  ),
};

/**
 * A row with no group is one line, and its glyph moves up to meet the title.
 * Beside it, the empty card: nothing synced and nothing to sync are the same
 * thing to the person reading, and both end with opening the app.
 */
export const CatchUpEdges: Story = {
  name: "Catch Up / single row and empty",
  render: () => (
    <Appearances
      render={(appearance) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <CatchUpWidgetPreview
            appearance={appearance}
            conversations={[{ id: "1", title: "Weekend Priority Sorting" }]}
          />
          <CatchUpWidgetPreview appearance={appearance} conversations={[]} />
        </div>
      )}
    />
  ),
};

/**
 * A stale snapshot drops what it can no longer claim and keeps what stays
 * true. The in-progress dots go, because nothing has confirmed that turn is
 * still running; the unread dot stays, because a message that arrived stays
 * unread until someone opens the app.
 */
export const CatchUpStale: Story = {
  name: "Catch Up / stale",
  render: () => (
    <Appearances
      render={(appearance) => (
        <CatchUpWidgetPreview
          appearance={appearance}
          conversations={CONVERSATIONS}
          isStale
        />
      )}
    />
  ),
};

/**
 * What a themed Home Screen should come out as. WidgetKit throws away every
 * color and redraws the widget in two monochrome groups from each view's
 * alpha, so each control swaps to a translucent white and the pupil is punched
 * out of the eye as a hole rather than painted on it.
 *
 * Imitated, not applied. Only a device proves this one.
 */
export const Flattened: Story = {
  name: "Themed Home Screen (flattened)",
  render: () => (
    <div
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        maxWidth: 720,
        padding: 20,
        borderRadius: 20,
        background: "#141416",
      }}
    >
      <QuickActionsWidgetPreview appearance="dark" unreadCount={3} flattened />
      <StatusWidgetPreview
        appearance="dark"
        unreadCount={3}
        inProgressCount={2}
        flattened
      />
      <CatchUpWidgetPreview
        appearance="dark"
        conversations={CONVERSATIONS}
        flattened
      />
    </div>
  ),
};

/**
 * The cards at twice their design size, for looking at the geometry rather
 * than the composition. Every measurement is multiplied by one scale factor,
 * the way the real views multiply theirs.
 */
export const Magnified: Story = {
  name: "Magnified (2x)",
  render: () => (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", maxWidth: 900 }}>
      <QuickActionsWidgetPreview scale={2} unreadCount={3} />
      <StatusWidgetPreview scale={2} unreadCount={3} inProgressCount={2} />
    </div>
  ),
};
