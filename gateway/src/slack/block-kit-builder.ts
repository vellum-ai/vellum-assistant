/**
 * Minimal Block Kit builder for constructing Slack Block Kit payloads.
 *
 * Slack's Block Kit is a JSON-based UI framework for building rich messages.
 * This builder provides a fluent API for the most common block types.
 *
 * @see https://api.slack.com/block-kit
 */

// ---------------------------------------------------------------------------
// Block type definitions
// ---------------------------------------------------------------------------

export interface TextObject {
  type: "mrkdwn" | "plain_text";
  text: string;
}

export interface SectionBlock {
  type: "section";
  text: TextObject;
}

export interface DividerBlock {
  type: "divider";
}

export interface HeaderBlock {
  type: "header";
  text: TextObject;
}

export interface RichTextBlock {
  type: "rich_text";
  elements: RichTextElement[];
}

export interface RichTextElement {
  type: "rich_text_section" | "rich_text_preformatted";
  elements: RichTextInlineElement[];
}

export interface RichTextInlineElement {
  type: "text";
  text: string;
  style?: { bold?: boolean; italic?: boolean; code?: boolean };
}

export type Block = SectionBlock | DividerBlock | HeaderBlock | RichTextBlock;

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

export function section(text: string): SectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function divider(): DividerBlock {
  return { type: "divider" };
}

export function header(text: string): HeaderBlock {
  // Header blocks only support plain_text
  return { type: "header", text: { type: "plain_text", text } };
}

// ---------------------------------------------------------------------------
// Fluent builder
// ---------------------------------------------------------------------------

export class BlockKitBuilder {
  private blocks: Block[] = [];

  section(text: string): this {
    this.blocks.push(section(text));
    return this;
  }

  divider(): this {
    this.blocks.push(divider());
    return this;
  }

  header(text: string): this {
    this.blocks.push(header(text));
    return this;
  }

  addBlock(block: Block): this {
    this.blocks.push(block);
    return this;
  }

  toBlocks(): Block[] {
    return [...this.blocks];
  }
}
