import { describe, test, expect } from 'bun:test';
import { attachmentsToContentBlocks } from '../agent/attachments.js';
import { createUserMessage } from '../agent/message-types.js';

// ---------------------------------------------------------------------------
// attachmentsToContentBlocks
// ---------------------------------------------------------------------------

describe('attachmentsToContentBlocks', () => {
  test('creates image content block for image/jpeg', () => {
    const blocks = attachmentsToContentBlocks([
      { filename: 'photo.jpg', mimeType: 'image/jpeg', data: 'base64data' },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
    const block = blocks[0] as { type: 'image'; source: { type: string; media_type: string; data: string } };
    expect(block.source.type).toBe('base64');
    expect(block.source.media_type).toBe('image/jpeg');
    expect(block.source.data).toBe('base64data');
  });

  test('creates image content block for image/png', () => {
    const blocks = attachmentsToContentBlocks([
      { filename: 'screenshot.png', mimeType: 'image/png', data: 'pngdata' },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
  });

  test('creates image content block for image/webp', () => {
    const blocks = attachmentsToContentBlocks([
      { filename: 'sticker.webp', mimeType: 'image/webp', data: 'webpdata' },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
  });

  test('creates file content block for non-image mime types', () => {
    const blocks = attachmentsToContentBlocks([
      { filename: 'doc.pdf', mimeType: 'application/pdf', data: 'pdfdata' },
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('file');
    const block = blocks[0] as { type: 'file'; source: { filename: string; media_type: string; data: string } };
    expect(block.source.filename).toBe('doc.pdf');
    expect(block.source.media_type).toBe('application/pdf');
  });

  test('handles multiple attachments including mixed types', () => {
    const blocks = attachmentsToContentBlocks([
      { filename: 'photo.jpg', mimeType: 'image/jpeg', data: 'imgdata' },
      { filename: 'notes.txt', mimeType: 'text/plain', data: 'txtdata' },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('image');
    expect(blocks[1].type).toBe('file');
  });

  test('returns empty array for no attachments', () => {
    const blocks = attachmentsToContentBlocks([]);
    expect(blocks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createUserMessage with image attachments
// ---------------------------------------------------------------------------

describe('createUserMessage with image attachments', () => {
  test('includes both text and image blocks', () => {
    const msg = createUserMessage('what is this?', [
      { filename: 'photo.jpg', mimeType: 'image/jpeg', data: 'base64img' },
    ]);

    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0].type).toBe('text');
    expect((msg.content[0] as { type: 'text'; text: string }).text).toBe('what is this?');
    expect(msg.content[1].type).toBe('image');
  });

  test('includes only image block when text is empty', () => {
    const msg = createUserMessage('', [
      { filename: 'photo.jpg', mimeType: 'image/jpeg', data: 'base64img' },
    ]);

    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe('image');
  });

  test('includes only image block when text is whitespace', () => {
    const msg = createUserMessage('   ', [
      { filename: 'photo.jpg', mimeType: 'image/jpeg', data: 'base64img' },
    ]);

    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe('image');
  });

  test('includes multiple image blocks', () => {
    const msg = createUserMessage('compare these', [
      { filename: 'a.jpg', mimeType: 'image/jpeg', data: 'img1' },
      { filename: 'b.png', mimeType: 'image/png', data: 'img2' },
    ]);

    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(3);
    expect(msg.content[0].type).toBe('text');
    expect(msg.content[1].type).toBe('image');
    expect(msg.content[2].type).toBe('image');
  });

  test('preserves base64 data in image content block', () => {
    const base64 = 'dGVzdC1pbWFnZS1kYXRh';
    const msg = createUserMessage('test', [
      { filename: 'photo.jpg', mimeType: 'image/jpeg', data: base64 },
    ]);

    const imageBlock = msg.content[1] as {
      type: 'image';
      source: { type: string; media_type: string; data: string };
    };
    expect(imageBlock.source.data).toBe(base64);
    expect(imageBlock.source.media_type).toBe('image/jpeg');
    expect(imageBlock.source.type).toBe('base64');
  });
});
