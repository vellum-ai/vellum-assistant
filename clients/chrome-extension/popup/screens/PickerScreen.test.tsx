import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PickerScreen, type PickerScreenProps } from './PickerScreen.js';

function renderPicker(overrides: Partial<PickerScreenProps> = {}): string {
  return renderToStaticMarkup(
    createElement(PickerScreen, {
      assistants: [],
      onSelect: () => {},
      onBack: () => {},
      onCreateAssistant: () => {},
      ...overrides,
    }),
  );
}

describe('PickerScreen', () => {
  test('renders an empty state that sends the user to create an assistant', () => {
    const html = renderPicker({ onRetry: () => {} });

    expect(html).toContain('You don&#x27;t have an assistant yet');
    expect(html).toContain('Create an assistant');
    expect(html).toContain('Refresh');
    expect(html).not.toContain('Loading assistants');
    expect(html).not.toContain('Select which assistant to connect');
  });

  test('lists assistants when the catalog is populated', () => {
    const html = renderPicker({
      assistants: [{ id: 'asst-123', name: 'Alice' }],
    });

    expect(html).toContain('Alice');
    expect(html).toContain('Select which assistant to connect to this browser.');
    expect(html).not.toContain('You don&#x27;t have an assistant yet');
    expect(html).not.toContain('Create an assistant');
  });

  test('shows a load error instead of the empty state', () => {
    const html = renderPicker({
      error: 'Failed to fetch assistants (403): forbidden',
      onRetry: () => {},
    });

    expect(html).toContain('Unable to load assistants');
    expect(html).toContain('Failed to fetch assistants (403): forbidden');
    expect(html).not.toContain('You don&#x27;t have an assistant yet');
  });
});
