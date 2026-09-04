/**
 * Whether the pointer is on the companion surface, which is the same question
 * as whether the companion window is taking mouse events.
 *
 * Written by the surface's `setInteractive`, and read by the input-activity
 * forwarder: a click on the companion is a press on Vellum's own controls,
 * not an edit in whatever the user was working in, and the offer those
 * controls answer must survive being pressed.
 *
 * A module of its own so neither side imports the other: the companion window
 * owns the surface, and the helper bridge owns the input stream.
 */
let onCompanion = false;

export const setPointerOnCompanion = (next: boolean): void => {
  onCompanion = next;
};

export const isPointerOnCompanion = (): boolean => onCompanion;
