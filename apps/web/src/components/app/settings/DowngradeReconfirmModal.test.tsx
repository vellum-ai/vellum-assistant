/**
 * Tests for `DowngradeReconfirmModal`.
 *
 * The web workspace lacks a DOM test runner, so we render the component as a
 * function call and walk the resulting React tree. This mirrors the approach
 * used in `ConfirmDialog.test.tsx`.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { isValidElement } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Modal } from "@vellum/design-library/components/modal";

import {
  DowngradeReconfirmModal,
  LOST_FEATURES,
} from "@/components/app/settings/DowngradeReconfirmModal.js";

type AnyElement = ReactElement<Record<string, unknown>>;

function render(
  props: Parameters<typeof DowngradeReconfirmModal>[0],
): AnyElement {
  return DowngradeReconfirmModal(props) as AnyElement;
}

function flattenChildren(node: unknown): AnyElement[] {
  if (Array.isArray(node)) {
    return node.flatMap(flattenChildren);
  }
  if (isValidElement(node)) {
    const el = node as AnyElement;
    return [el, ...flattenChildren(el.props.children)];
  }
  return [];
}

function findAllByType(root: AnyElement, type: unknown): AnyElement[] {
  return flattenChildren(root).filter((el) => el.type === type);
}

function findByType(root: AnyElement, type: unknown): AnyElement | undefined {
  return findAllByType(root, type)[0];
}

describe("LOST_FEATURES catalog", () => {
  test("contains exactly three bullet items", () => {
    expect(LOST_FEATURES).toHaveLength(3);
  });

  test("each item has a stable id and a non-empty label", () => {
    for (const feature of LOST_FEATURES) {
      expect(typeof feature.id).toBe("string");
      expect(feature.id.length).toBeGreaterThan(0);
      expect(typeof feature.label).toBe("string");
      expect(feature.label.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique stable React keys", () => {
    // The IDs are used only as React `key` props for the rendered <li>
    // entries. We pin the exact list so reordering or renaming an ID is a
    // deliberate, reviewed change (stable reconciliation across renders),
    // not because the server consumes them — the prior `ack_lost_features`
    // audit-trail contract was removed with the downgrade endpoint.
    expect(LOST_FEATURES.map((f) => f.id)).toEqual([
      "custom_domain",
      "static_ip",
      "priority_support",
    ]);
  });
});

describe("DowngradeReconfirmModal composes Modal.*", () => {
  const baseProps = {
    open: true,
    onCancel: () => {},
    onConfirm: () => {},
    confirming: false,
  };

  test("Root reflects the open prop", () => {
    const tree = render(baseProps);
    expect(tree.type).toBe(Modal.Root);
    expect(tree.props.open).toBe(true);
  });

  test("Content uses size='md' and hides the close button", () => {
    const tree = render(baseProps);
    const content = findByType(tree, Modal.Content);
    expect(content).toBeDefined();
    expect(content!.props.size).toBe("md");
    expect(content!.props.hideCloseButton).toBe(true);
  });

  test("renders Header / Body / Footer sections", () => {
    const tree = render(baseProps);
    expect(findByType(tree, Modal.Header)).toBeDefined();
    expect(findByType(tree, Modal.Body)).toBeDefined();
    expect(findByType(tree, Modal.Footer)).toBeDefined();
  });

  test("renders one <li> per LOST_FEATURES entry", () => {
    const tree = render(baseProps);
    const items = flattenChildren(tree).filter((el) => el.type === "li");
    expect(items).toHaveLength(LOST_FEATURES.length);
  });
});

describe("DowngradeReconfirmModal callback wiring", () => {
  test("does not call onConfirm until the Confirm Downgrade button is clicked", () => {
    const onConfirm = mock(() => {});
    const tree = render({
      open: true,
      onCancel: () => {},
      onConfirm,
      confirming: false,
    });
    // Just rendering should not invoke the callback.
    expect(onConfirm).not.toHaveBeenCalled();
    const buttons = findAllByType(tree, Button);
    // [0] = Keep Pro, [1] = Confirm Downgrade
    const confirmClick = buttons[1]!.props.onClick as () => void;
    confirmClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("pressing Cancel calls onCancel and does not call onConfirm", () => {
    const onCancel = mock(() => {});
    const onConfirm = mock(() => {});
    const tree = render({
      open: true,
      onCancel,
      onConfirm,
      confirming: false,
    });
    const buttons = findAllByType(tree, Button);
    const cancelClick = buttons[0]!.props.onClick as () => void;
    cancelClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("Modal.Root.onOpenChange(false) — Escape / backdrop path — fires onCancel", () => {
    const onCancel = mock(() => {});
    const tree = render({
      open: true,
      onCancel,
      onConfirm: () => {},
      confirming: false,
    });
    const onOpenChange = tree.props.onOpenChange as (open: boolean) => void;
    onOpenChange(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("Modal.Root.onOpenChange(true) does not fire onCancel", () => {
    const onCancel = mock(() => {});
    const tree = render({
      open: true,
      onCancel,
      onConfirm: () => {},
      confirming: false,
    });
    const onOpenChange = tree.props.onOpenChange as (open: boolean) => void;
    onOpenChange(true);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("Modal.Root.onOpenChange(false) is a no-op while confirming=true (Esc / backdrop guard)", () => {
    const onCancel = mock(() => {});
    const tree = render({
      open: true,
      onCancel,
      onConfirm: () => {},
      confirming: true,
    });
    const onOpenChange = tree.props.onOpenChange as (open: boolean) => void;
    onOpenChange(false);
    // While the downgrade mutation is in-flight, Esc/backdrop must not close
    // the dialog. Both buttons are already disabled, but onOpenChange runs
    // outside the button path.
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("confirming=true disables both buttons", () => {
    const tree = render({
      open: true,
      onCancel: () => {},
      onConfirm: () => {},
      confirming: true,
    });
    const buttons = findAllByType(tree, Button);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.props.disabled).toBe(true);
    expect(buttons[1]!.props.disabled).toBe(true);
  });

  test("confirming=false leaves both buttons enabled", () => {
    const tree = render({
      open: true,
      onCancel: () => {},
      onConfirm: () => {},
      confirming: false,
    });
    const buttons = findAllByType(tree, Button);
    expect(buttons[0]!.props.disabled).toBe(false);
    expect(buttons[1]!.props.disabled).toBe(false);
  });

  test("confirm button is the danger variant", () => {
    const tree = render({
      open: true,
      onCancel: () => {},
      onConfirm: () => {},
      confirming: false,
    });
    const buttons = findAllByType(tree, Button);
    expect(buttons[1]!.props.variant).toBe("danger");
    expect(buttons[1]!.props["data-testid"]).toBe("confirm-downgrade-button");
  });
});
