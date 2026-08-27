import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PickerScreen } from './PickerScreen.js';

describe('PickerScreen', () => {
  test('renders an empty state that sends the user to create an assistant', () => {
    const html = renderToStaticMarkup(
      <PickerScreen
        assistants={[]}
        onSelect={() => {}}
        onBack={() => {}}
        onRetry={() => {}}
        onCreateAssistant={() => {}}
      />,
    );

    expect(html).toContain("You don't have an assistant yet");
    expect(html).toContain('Create an assistant');
    expect(html).toContain('Refresh');
    expect(html).not.toContain('Loading assistants');
    expect(html).not.toContain('Select which assistant to connect');
  });

  test('lists assistants when the catalog is populated', () => {
    const html = renderToStaticMarkup(
      <PickerScreen
        assistants={[{ id: 'asst-123', name: 'Alice' }]}
        onSelect={() => {}}
        onBack={() => {}}
        onCreateAssistant={() => {}}
      />,
    );

    expect(html).toContain('Alice');
    expect(html).toContain('Select which assistant to connect to this browser.');
    expect(html).not.toContain("You don't have an assistant yet");
    expect(html).not.toContain('Create an assistant');
  });

  test('shows a load error instead of the empty state', () => {
    const html = renderToStaticMarkup(
      <PickerScreen
        assistants={[]}
        error="Failed to fetch assistants (403): forbidden"
        onSelect={() => {}}
        onBack={() => {}}
        onRetry={() => {}}
        onCreateAssistant={() => {}}
      />,
    );

    expect(html).toContain('Unable to load assistants');
    expect(html).toContain('Failed to fetch assistants (403): forbidden');
    expect(html).not.toContain("You don't have an assistant yet");
  });
});
