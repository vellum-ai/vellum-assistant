/**
 * Composable builder for Slack Block Kit elements.
 *
 * Analogous to Telegram's `buildInlineKeyboard()` and WhatsApp's
 * `selectWhatsAppButtons()` — provides a fluent API for constructing
 * Slack Block Kit payloads.
 */

// ---------------------------------------------------------------------------
// Block Kit element types
// ---------------------------------------------------------------------------

export type MrkdwnText = {
  type: "mrkdwn";
  text: string;
};

export type PlainText = {
  type: "plain_text";
  text: string;
  emoji?: boolean;
};

export type TextObject = MrkdwnText | PlainText;

export type ButtonElement = {
  type: "button";
  text: PlainText;
  action_id: string;
  value?: string;
  style?: "primary" | "danger";
};

export type SectionBlock = {
  type: "section";
  text: MrkdwnText;
};

export type ActionsBlock = {
  type: "actions";
  elements: ButtonElement[];
};

export type ContextBlock = {
  type: "context";
  elements: TextObject[];
};

export type DividerBlock = {
  type: "divider";
};

export type HeaderBlock = {
  type: "header";
  text: PlainText;
};

export type Block =
  | SectionBlock
  | ActionsBlock
  | ContextBlock
  | DividerBlock
  | HeaderBlock;

// ---------------------------------------------------------------------------
// Button builder
// ---------------------------------------------------------------------------

export type ButtonOptions = {
  actionId: string;
  text: string;
  value?: string;
  style?: "primary" | "danger";
};

export function button(opts: ButtonOptions): ButtonElement {
  const btn: ButtonElement = {
    type: "button",
    text: { type: "plain_text", text: opts.text, emoji: true },
    action_id: opts.actionId,
  };
  if (opts.value !== undefined) btn.value = opts.value;
  if (opts.style !== undefined) btn.style = opts.style;
  return btn;
}

// ---------------------------------------------------------------------------
// Block Kit builder (fluent / chainable)
// ---------------------------------------------------------------------------

export class BlockKitBuilder {
  private blocks: Block[] = [];

  /** Add a section block with mrkdwn text. */
  section(text: string): this {
    this.blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    return this;
  }

  /** Add a divider block. */
  divider(): this {
    this.blocks.push({ type: "divider" });
    return this;
  }

  /** Add an actions block containing one or more buttons. */
  actions(buttons: ButtonElement[]): this {
    this.blocks.push({ type: "actions", elements: buttons });
    return this;
  }

  /** Add a context block with one or more text elements. */
  context(elements: TextObject[]): this {
    this.blocks.push({ type: "context", elements });
    return this;
  }

  /** Shorthand: add a context block with a single mrkdwn string. */
  contextMrkdwn(text: string): this {
    return this.context([{ type: "mrkdwn", text }]);
  }

  /** Add a header block with plain text. */
  header(text: string): this {
    this.blocks.push({
      type: "header",
      text: { type: "plain_text", text, emoji: true },
    });
    return this;
  }

  /** Return the accumulated blocks array. */
  toBlocks(): Block[] {
    return this.blocks;
  }

  // -------------------------------------------------------------------------
  // Static entry points for one-liner starts
  // -------------------------------------------------------------------------

  static section(text: string): BlockKitBuilder {
    return new BlockKitBuilder().section(text);
  }

  static header(text: string): BlockKitBuilder {
    return new BlockKitBuilder().header(text);
  }

  static divider(): BlockKitBuilder {
    return new BlockKitBuilder().divider();
  }
}

// ---------------------------------------------------------------------------
// Common pattern helpers
// ---------------------------------------------------------------------------

/**
 * Build an approval prompt with a message, action buttons, and a context hint.
 *
 * Mirrors the approval payloads used by Telegram's `buildInlineKeyboard()`
 * and WhatsApp's interactive buttons.
 */
export function approvalPrompt(opts: {
  message: string;
  requestId: string;
  actions: Array<{ id: string; label: string; style?: "primary" | "danger" }>;
}): Block[] {
  const buttons = opts.actions.map((action) =>
    button({
      actionId: `apr:${opts.requestId}:${action.id}`,
      text: action.label,
      value: `apr:${opts.requestId}:${action.id}`,
      style: action.style,
    }),
  );

  return new BlockKitBuilder()
    .section(opts.message)
    .actions(buttons)
    .toBlocks();
}

/**
 * Build a permission request prompt — a specialised approval prompt with
 * consistent styling for approve/reject actions.
 */
export function permissionRequest(opts: {
  message: string;
  requestId: string;
}): Block[] {
  return approvalPrompt({
    message: opts.message,
    requestId: opts.requestId,
    actions: [
      { id: "approve_once", label: "Approve", style: "primary" },
      { id: "reject", label: "Reject", style: "danger" },
    ],
  });
}

/**
 * Build a progress indicator block set — a section with a status emoji and
 * a context line showing the current step.
 */
export function progressIndicator(opts: {
  title: string;
  status: string;
}): Block[] {
  return new BlockKitBuilder()
    .section(opts.title)
    .contextMrkdwn(opts.status)
    .toBlocks();
}

/**
 * Build an error message block set — a header-less section with danger
 * styling context.
 */
export function errorMessage(opts: {
  message: string;
  detail?: string;
}): Block[] {
  const builder = new BlockKitBuilder().section(`:warning: ${opts.message}`);
  if (opts.detail) {
    builder.contextMrkdwn(opts.detail);
  }
  return builder.toBlocks();
}
