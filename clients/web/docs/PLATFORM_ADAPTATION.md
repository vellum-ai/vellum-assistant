# Platform Adaptation

The same `clients/web` bundle runs in four places: a desktop browser, an
[Electron](https://www.electronjs.org/) shell (`clients/macos`, `clients/windows`), and
[Capacitor](https://capacitorjs.com/) WebViews on iOS and Android. When a surface needs to look or
behave differently in one of them, this document says whether that difference should be a conditional
at all, which signal it branches on, and where the branch belongs.

Read this before writing any `isMobile ? … : …`, `isNativeIOS()`, or `pointer: coarse` check.

---

## Three axes, not one boolean

"Mobile" is three independent questions, and answering the wrong one is the most common bug in this
area:

| Axis | Question | Signal | Do not use it for |
|------|----------|--------|-------------------|
| **Window size** | How much room is there? | `useIsMobile()`, Tailwind `max-md:` | Deciding which overlay or affordance to use |
| **Input capability** | Mouse or thumb? | `isPointerCoarse()`; `useTouchMobile()` for narrow **and** coarse | Deciding how much fits on screen |
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

#### Measured sizes: no new JavaScript `clamp()`

The same preference, one level down. `useLayoutViewportSize()` and `useElementSize()`
([`src/hooks/use-element-size.ts`](../src/hooks/use-element-size.ts)) hand you a live `{ w, h }`, and it
is tempting to do the sizing arithmetic in JavaScript. If `clamp()`, `min()`, `vmin`, `vw`, `dvh` or `%`
can express the rule, write it in CSS instead. Most of this app already does
(`max-w-[min(520px,calc(100vw-8rem))]`, `w-[90vw] max-w-[800px]`).

This is not a style preference. CSS units resolve against a defined box automatically, so they cannot
disagree with the `%`-positioned content beside them. JavaScript has to *pick* a box, and there are
three plausible answers here (the layout viewport, the visual viewport, and the container), which is
how a decorative layer ends up half a safe-area inset out of register with the foreground it is pinned
to. CSS also updates without a React render.

Reach for a measured size only when CSS genuinely cannot: a number handed to an animation library, or
one paired with a `getBoundingClientRect()`.

**Direction of travel.** The onboarding and voice-room decorative layers predate this rule and compute
`clamp()` in JavaScript today (`edgeSize` is literally `clamp(130px, 40vmin, 420px)`). That is tracked
in LUM-3204 and is being unwound per surface, so treat those files as the pattern being retired rather
than the example to copy. New consumers of the measured-size hooks should be able to say which of the
two exceptions above they fall under.

### Input capability

The pointer is the signal for **interaction**: which overlay a trigger opens, whether long-press is
the way in, whether a hover-revealed affordance can exist at all. `isPointerCoarse()`
([`src/utils/pointer.ts`](../src/utils/pointer.ts)) is that axis by itself, and it is what a purely
interactive question should read, for example gating a hardware-keyboard-only affordance (see
[`CAPACITOR.md`: Keyboard-only affordances](./CAPACITOR.md#keyboard-only-affordances-on-touch-devices)).

`useTouchMobile()` ([`src/hooks/use-touch-mobile.ts`](../src/hooks/use-touch-mobile.ts)) is **not**
that axis. It is a compound of narrow viewport **and** coarse pointer, mirroring the design library's
`touch-mobile:` variant in [`tokens.css`](../../../packages/design-library/src/tokens.css), so read it
as "a phone-shaped device" rather than "a touch device". Know what it excludes: a tablet in landscape
is coarse but roomy, so the hook is false there and a surface forking on it alone serves the
pointer-oriented branch to a thumb. That is a known gap in today's overlay call sites, and the reason
the fork belongs inside the primitive (rung 3), where the size half and the pointer half can be
weighed per surface instead of ANDed once for all of them.

Use the compound only when both halves genuinely matter: a bottom sheet wants a thumb *and* wants the
narrow window that leaves no room to anchor.

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

## Which conditionals should exist at all

Moving branches into primitives is not a campaign to reach zero conditionals. Some differences are
genuinely the caller's to decide, and burying those inside a component makes the code harder to follow,
not easier. One question separates the two:

**Would every caller asking this question want the same answer?**

If yes, the caller should not be asking. "Does a menu open as a dropdown or a sheet" has one right
answer for every menu in the app, so a dozen callers computing it independently is a dozen chances to
disagree, and they already do (a focus fix and a max-height cap that exist in one copy and not its
neighbour). That belongs to the primitive, and the caller writes `Menu`.

If no, keep the conditional. "Does the detail sit beside the list or replace it", "how many chips fit
before collapsing into a count", "is the composer compact" all depend on what surrounds the surface,
which only the page knows. A primitive that guessed would be guessing with less information than its
caller had.

Two corollaries worth stating, because they are the cases people get wrong in both directions:

- **A prop carrying an axis down the tree is almost always the wrong shape.** `isMobile` as a prop
  means one component asked a question on another component's behalf, so the answer can be wrong at
  the point it is used and no type catches it. Whoever makes the choice reads the signal where the
  choice is made. Passing a *decision* down (`showCategories`) is fine; passing the *raw axis* down is
  not.
- **Two surfaces that substitute for each other are one decision, not two.** See
  [the hidden-surface rule](#when-css-hides-a-surface-the-substitute-needs-the-same-signal) below: if a
  control moves from one place to another as the window changes, one owner decides and both sides
  follow, or there is a viewport where it lives in neither.

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

**Built for command menus, not yet for arbitrary content.** `ActionMenu`
([`packages/design-library/src/components/action-menu.tsx`](../../../packages/design-library/src/components/action-menu.tsx))
is this rung: items are declared once, and it renders an anchored dropdown under a pointer or a bottom
sheet under a thumb, resolving `useTouchSurface()` itself. A menu is the case that pays most, because
the two presentations there disagree on the *items* as well as the container, so the second copy is a
whole item list rather than a wrapper.

Reach for `ActionMenu` for any list of commands. Two gaps remain, and both are reasons to keep using
`Menu` and `BottomSheet` directly rather than to write a new fork:

- **Submenus.** A nested branch has no settled sheet equivalent, so a menu with `Menu.Sub` stays as is.
- **Arbitrary content.** A disclosure holding a filter panel or a form is not a command list, and its
  primitive can only own the shell (portal, focus, dismissal, height band, safe area) rather than the
  content. The pills and filter surfaces still fork on the signal for that reason.

Either way, do not add a new copy of `isTouchMobile ? Sheet : Popover` for a command menu.

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

## When CSS hides a surface, the substitute needs the same signal

The most common way an adaptive layout loses a control: one component hides itself in CSS
(`hidden sm:block`) while a sibling decides in JS whether to carry the same control, and the two use
different thresholds. Nothing connects them, so the gap between the thresholds is a viewport where
the control exists in neither surface, and no type or test notices.

Mirroring the class in JS does not fix it, it just writes the drift down: a `(min-width: 40rem)`
constant next to a "keep this in sync with `sm:block`" comment is two thresholds again, plus a fourth
breakpoint nobody else uses.

So when a surface has a substitute, don't hide it in CSS at all. One owner reads one shared signal
(`useIsMobile()`, not a bespoke query) and both halves follow from it: the surface renders only when
that signal says there is room, and the substitute carries the control exactly when it doesn't. In the
superpowers page the category rail mounts only on a roomy window and the filter control grows a
Categories section only on a narrow one, from the same boolean, so there is no viewport where
categories are missing and none where they appear twice.

Tie the substitution to **the absence of the thing it replaces**, never to a proxy like the pointer:
otherwise a narrow mouse-driven window falls between the two.

---

## Hiding a control behind hover

A control revealed on hover is unreachable on a device that cannot hover, and hover is its own axis:
[`hover`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover) does not follow from
[`pointer`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer) or from window size. An
iPad in landscape reports `hover: none` at 1024px. So a hidden control needs an answer to "what
reaches this without a hover", and the answer is a product decision, not a media query. Decide it in
this order:

1. **Decoration over something already interactive** (a scrim, a "click to open" hint on a card that
   is itself a button): nothing more is needed. The row does the work; the hint only previews it.
2. **One action**: don't hide it. A row with a single affordance has nothing to gain from hiding it and
   a reachability bug to lose.
3. **Several actions**: one always-visible trigger opening an [`ActionMenu`](../../../packages/design-library/src/components/action-menu.tsx),
   which is a dropdown under a mouse and a sheet under a thumb.
4. **A long list of like rows** (conversations, library apps): swipe or long-press, and the caller
   drops the hover control on touch rather than asking the primitive to hide it. See
   `conversation-row.tsx`.
5. **Anything else**: keep it visible where hover is unavailable.

The mechanism is one rule in the design library's stylesheet, not a class list each caller pastes.
Callers declare parts, the rule owns the conditions:

```html
<div data-reveal-row data-reveal-hold>
  <button data-reveal>…</button>
  <span data-reveal-yield>…</span>
</div>
```

- `data-reveal-row` scopes the reveal: the affordance appears while this element is hovered, while
  keyboard focus is anywhere inside it (`:focus-visible`, so a click on the row does not count), and
  while a menu the affordance owns reports `aria-expanded`.
- `data-reveal` is the affordance. Its opacity and its `pointer-events` are set by the same
  declaration, since an unpainted control that still answers a click is a trap.
- `data-reveal-yield` is an element sharing the affordance's slot and giving it up, so the two
  crossfade in one cell instead of stacking. It leaves the hit path while faded, since the cell it
  shares would otherwise put it over the affordance painted under it. It only means anything inside a
  [`CrossfadeStack`](../../../packages/design-library/src/components/crossfade-stack.tsx), which marks
  the shared cell: a hand-rolled slot gets a permanently hidden occupant instead.
- `data-reveal-hold` keeps the affordance up regardless of hover, for a row whose state makes it the
  live control (the nav's current page, a voice mid-preview, a fact already removed).

Where the device cannot hover, the affordance is simply present, and a shared cell seats both
occupants side by side rather than choosing one, which is why options 1 through 5 have to be settled
first: a row that would rather stay narrow drops the affordance itself and gives the command a path
of its own.

Whichever signal a caller reads in TypeScript, read it as capability
([`useShowsHoverAffordance`](../src/hooks/use-hover-affordance.ts)) and make it describe the path that
actually replaces the control. A row whose replacement is a gesture has to check that the gesture is
armed, since a hoverless device with a fine pointer (a stylus) gets neither hover nor gestures.

---

## Swipe edges under the chat shell

Every route under `ChatLayout` shares a document-level drawer gesture: a rightward drag beginning in
the left half of a mobile viewport opens the navigation drawer. A row there keeps its swipe commands
on the **trailing** edge, or the two gestures resolve to the drawer and the row's leading action is
unreachable in practice.

Inside the open drawer the contested edge flips: a leftward drag closes it
([`useSwipeCloseDrawer`](../src/hooks/use-swipe-close-drawer.ts)). Rows keep both edges there,
because that gesture stands down over anything marked `data-slot="swipe-action-row"`, which
[`SwipeActionReveal`](../src/components/swipe-action-reveal.tsx) sets on the branch that arms its own
handlers. A panel gesture layered over rows needs the same opt-out, or it takes drags the rows were
built to answer.

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
  split cannot fit at 767px whatever the pointer is, so `ChatMainPanel` reads `useIsMobile()`.
- **Safe-area padding under a full-screen sheet** is the platform axis, resolved in CSS off
  `data-native-platform` rather than by a component asking which OS it is on.

---

## Related docs

- [`CAPACITOR.md`](./CAPACITOR.md): native capability rules, WebView defects, permission UI, and the
  citation requirement for platform short-circuits.
- [`ELECTRON.md`](./ELECTRON.md): the renderer/bridge boundary for desktop shells.
- [`CONVENTIONS.md`: Platform gating](./CONVENTIONS.md#platform-gating), a different axis with a
  confusingly similar name: hosting and auth (`usePlatformGate()`), not device platform.
