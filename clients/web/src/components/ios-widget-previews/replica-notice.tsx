/* eslint-disable local/no-untranslated-strings --
 * Storybook chrome, not product copy. This renders only in a story canvas, is
 * read by whoever is working on the widgets, and never ships in the app, so
 * there is no user to translate it for and no catalog it belongs in. The
 * neighbouring files carry their own, different exemption: theirs reproduce
 * copy hardcoded in the Swift.
 */
/**
 * The standing disclaimer above every widget story.
 *
 * The Docs tab carries the long version, but a person landing on a story
 * canvas sees only the cards, and cards that look this much like the real
 * thing are exactly the ones worth labelling. So the warning rides the canvas
 * rather than the documentation.
 *
 * This is the one piece in this directory that is app chrome rather than a
 * replica of native SwiftUI, so it is the one piece built from the design
 * library.
 */

import { Notice } from "@vellumai/design-library";

export function ReplicaNotice() {
  return (
    <Notice
      tone="warning"
      title="A replica, not the widget"
      className="mb-4 max-w-[720px]"
    >
      <p>
        The real widgets are SwiftUI compiled into an iOS app extension, and
        nothing renders SwiftUI in Storybook. These are React copies, reading a
        palette and geometry transcribed out of{" "}
        <code>clients/ios/App/VoiceActivity/Widgets/</code>, and they are worth
        exactly as much as that copy is current.
      </p>
      <p className="mt-2">
        The eyes are exact, from the same Bezier control points. The SF Symbols
        beside them are hand-drawn stand-ins, the type is not SF Pro off an
        Apple device, and the themed Home Screen is painted rather than applied.
        The <code>#Preview</code> blocks in the Swift render the real views and
        are what to believe.
      </p>
    </Notice>
  );
}
