# Platform Adaptation

The same `clients/web` bundle runs in four places: a desktop browser, an
[Electron](https://www.electronjs.org/) shell (`clients/macos`, `clients/windows`), and
[Capacitor](https://capacitorjs.com/) WebViews on iOS and Android. When a surface needs to look or
behave differently in one of them, this document says which signal to branch on and where the branch
belongs.

Read this before writing any `isMobile ? … : …`, `isNativeIOS()`, or `pointer: coarse` check.

---

## Three axes, not one boolean

"Mobile" is three independent questions, and answering the wrong one is the most common bug in this
area:

| Axis | Question | Signal | Do not use it for |
|------|----------|--------|-------------------|
| **Window size** | How much room is there? | `useIsMobile()`, Tailwind `max-md:` | Deciding which overlay or affordance to use |
| **Input capability** | Mouse or thumb? | `useTouchMobile()`, `isPointerCoarse()`, `touch-mobile:` | Deciding how much fits on screen |
| **Platform** | Which OS idiom and which native capabilities? | `data-native-platform` + `native-mobile:`, `useIsNativeIOS()` / `useIsNativeAndroid()`, `detectClientOs()` | Anything that is really about size or input |

None of the three implies another. A narrow Electron window is compact **with a mouse**. An iPad is
roomy **with a thumb**. An iOS phone and an Android phone agree on size and input and differ only on
the third axis. Android's own guidance makes the same point for the size axis: window size classes are
["not determined by the size of the device screen"](https://developer.android.com/develop/adaptive-apps/guides/use-window-size-classes)
and are not meant for `isTablet`-style logic.

So a viewport-width check standing in for "is this a touch device" is wrong in both directions: it
gives a desktop window narrowed by DevTools or macOS tiling the thumb-sized UI, and it gives a
landscape tablet the hover-oriented UI.

### Window size

`useIsMobile()` ([`src/hooks/use-is-mobile.ts`](../src/hooks/use-is-mobile.ts)) is a
`max-width: 767px` [media query](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_media_queries/Using_media_queries),
matching Tailwind's `md` breakpoint. Use it for **layout**: how many columns, whether a panel docks or
stacks, how many chips fit before truncating. Prefer plain `max-md:` classes when CSS can express it,
and reach for the hook only when the difference is structural (different components, different props).

### Input capability

`useTouchMobile()` ([`src/hooks/use-touch-mobile.ts`](../src/hooks/use-touch-mobile.ts)) requires a
narrow viewport **and** a coarse pointer, mirroring the design library's `touch-mobile:` variant in
[`tokens.css`](../../../packages/design-library/src/tokens.css). This is the signal for
**interaction**: which overlay a trigger opens, whether long-press is the way in, whether a
hover-revealed affordance can exist at all. Use `isPointerCoarse()`
([`src/utils/pointer.ts`](../src/utils/pointer.ts)) directly when the viewport half is irrelevant, for
example when gating a hardware-keyboard-only affordance (see
[`CAPACITOR.md`: Keyboard-only affordances](./CAPACITOR.md#keyboard-only-affordances-on-touch-devices)).

References: MDN [`pointer`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer) and
[`hover`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover) media features.

### Platform

`detectClientOs()` and the `useIsNative*` hooks
([`src/runtime/platform-detection.ts`](../src/runtime/platform-detection.ts)) wrap
[`Capacitor.getPlatform()`](https://capacitorjs.com/docs/basics/utilities) and the Electron host OS.
`initNativePlatformAttributes()` stamps `data-native-platform="ios" | "android"` on `<html>` at boot,
which the `native-mobile:` variant in [`index.css`](../src/index.css) keys off.

Use the platform axis for exactly two things:

1. **Native capability**: safe-area insets, keyboard avoidance, the hardware back button, haptics,
   plugin availability, and documented WebView defects. `CAPACITOR.md` is the authority here, and it
   sets the bar for a platform branch: UA/platform branching is appropriate only when an API is
   *present but broken* on that runtime, with a citation at the call site.
2. **OS idiom**: the visual grammar users expect from the shell they launched.

Not for layout, and not for "is this touch". Both have their own axis.

---

## The ladder: where the branch goes

Pick the cheapest rung that expresses the difference. Every rung down adds a place for the platforms
to drift apart.

**1. Tokens and a root attribute (preferred).** The platform is already on `<html>`, so a difference
that is purely visual is a CSS variable or a `native-mobile:` / `touch-mobile:` utility. No JS, no
component knows, no caller involved. This is what [Ionic](https://ionicframework.com/docs/theming/platform-styles)
does with its `ios` and `md` modes: one component implementation, platform-specific styling resolved
by class. Two details from Ionic worth keeping: it reduces the world to **two** modes rather than one
per platform, and it keeps the mode overridable so appearance is a deliberate choice rather than a
detection side effect.

**2. A variant prop on one component.** Same component, different arrangement, chosen by the layer
that has the context. Cheap to review, and the variants sit next to each other where a reader can
compare them.

**3. Adaptation inside the primitive.** When one intent has two presentations (a menu that is a
dropdown under a mouse and a sheet under a thumb), the primitive resolves it and callers describe
intent. This is [Tamagui's `Adapt`](https://tamagui.dev/ui/dialog) and the
[Credenza](https://github.com/redpangilinan/credenza) recipe over shadcn's Dialog and
[vaul](https://vaul.emilkowal.ski/). Callers must **not** each write the branch: every copy of
`isTouchMobile ? Sheet : Popover` is another chance for focus handling, sizing, and dismissal to
diverge between the two presentations.

Two things to get right on this rung:

- **Provide an override.** Some surfaces are deliberately fixed (a lightbox is a lightbox on every
  platform). The primitive takes an explicit prop; the caller does not reach for the raw signal.
- **Expect a remount.** Switching presentation reparents the subtree, so component state inside it is
  lost. Tamagui documents the same caveat. Adapting on input capability rather than live width keeps
  this to the rare case of a desktop window crossing the breakpoint mid-session, but do not put
  unsaved form state in a surface that can flip.

**4. Separate implementations behind one import (last resort).** React Native's
[platform-specific code](https://reactnative.dev/docs/platform-specific-code) guidance is the right
mental model: `Platform.select` when only small parts differ, `.ios.tsx` / `.android.tsx` files when
the implementation genuinely diverges. Two files means two things to keep in sync, so this needs a
reason a variant cannot cover.

---

## Navigation depth and back affordances

Adaptive layout has a second failure mode beyond overlays: a route that is a detail pane beside its
list on a roomy window becomes a pushed screen on a compact one, and if both the layout chrome and
the page render a back control the user sees two.

The rule:

- **The route hierarchy owns depth.** Whether a surface is nested is a property of the route, not
  something a page decides for itself or infers from a prop.
- **One owner renders the back affordance.** The layout chrome that owns the header renders exactly
  one, derived from that depth. Pages never render their own back control, and a page that is a pane
  on a roomy window must not grow a second header when it becomes a full screen.
- **Window size decides pane versus screen** (list plus detail, or list then detail), which is the
  window-size axis: see [Material's canonical list-detail layout](https://m3.material.io/foundations/layout/canonical-layouts/list-detail).
- **Platform decides only whether an explicit back control is warranted at all.** Android supplies a
  system back gesture and predictive back
  ([guidance](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture)),
  while iOS expects an in-bar back button plus an edge swipe
  ([HIG: Navigation bars](https://developer.apple.com/design/human-interface-guidelines/navigation-bars)).
  That is an idiom difference at rung 1 or 2, not a reason for a page to render its own header.

---

## Should iOS and Android differ?

Sometimes, and the split is clean:

- **Idiom and styling**: yes, at rung 1. Corner radii, transition feel, where a destructive action
  sits. Cheap and contained.
- **Native capability**: yes, in JS, inside the primitive or a hook. Safe-area insets, keyboard
  avoidance, the Android hardware back button, haptics. This is where real bugs live.
- **Layout and information architecture**: no. That is the window-size axis and must not know which OS
  it is on.

When you do add a platform branch for one mobile platform, decide explicitly whether the other needs
it too, per [`clients/AGENTS.md`](../../AGENTS.md).

---

## Worked examples

- **Which overlay a trigger opens** is the input axis. `ConversationActionsMenu` opens a
  `BottomSheet` under a thumb and a `Menu` under a mouse, so it reads `useTouchMobile()`. A narrow
  desktop window keeps the dropdown, because a mouse can hit it.
- **Whether a detail pane docks beside the chat or floats over it** is the size axis. A side-by-side
  split cannot fit at 767px whatever the pointer is, so `ChatRouteContent` reads `useIsMobile()`.
- **Safe-area padding under a full-screen sheet** is the platform axis, resolved in CSS off
  `data-native-platform` rather than by a component asking which OS it is on.

---

## Related docs

- [`CAPACITOR.md`](./CAPACITOR.md): native capability rules, WebView defects, permission UI, and the
  citation requirement for platform short-circuits.
- [`ELECTRON.md`](./ELECTRON.md): the renderer/bridge boundary for desktop shells.
- [`CONVENTIONS.md`: Platform gating](./CONVENTIONS.md#platform-gating), a different axis with a
  confusingly similar name: hosting and auth (`usePlatformGate()`), not device platform.
