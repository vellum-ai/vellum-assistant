"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "sse-event-stream", label: "SSE Event Stream", level: 2 },
  { id: "event-types", label: "Event Types", level: 3 },
  { id: "connection-management", label: "Connection Management", level: 3 },
  { id: "javascript-example", label: "JavaScript Example", level: 3 },
  { id: "remote-access", label: "Remote Access", level: 2 },
  { id: "remote-troubleshooting", label: "Troubleshooting", level: 3 },
];

export function DeveloperGuideApiContent() {
  return (
    <>
      <DocsContent title="API & Communication" breadcrumb="Docs / Developer Guide / API">
        <p className="mb-8 text-zinc-600">
          The runtime exposes a real-time SSE event stream for streaming assistant responses, and supports remote access via SSH port forwarding.
        </p>

        {/* SSE */}
        <section id="sse-event-stream">
          <SectionHeading id="sse-event-stream" level={2}>
            SSE Event Stream
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`GET /v1/events?conversationKey=<key>`}
          </pre>
          <p className="mb-4 text-zinc-600">
            JWT bearer auth with <code className="text-sm">chat.read</code> scope. Streams real-time assistant events.
            When <code className="text-sm">conversationKey</code> is omitted, subscribes to events from all conversations.
            Heartbeat comments are emitted every 30 seconds to prevent proxy timeouts.
          </p>

          <section id="event-types" className="mt-6">
            <SectionHeading id="event-types" level={3}>
              Event Types
            </SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700">
                    <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Event</th>
                    <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Description</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-600 dark:text-zinc-400">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">assistant_text_delta</code></td>
                    <td className="py-2">Incremental text token from the model</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">assistant_thinking_delta</code></td>
                    <td className="py-2">Reasoning token</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">tool_use_start</code></td>
                    <td className="py-2">Tool invocation starting</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">tool_input_delta</code></td>
                    <td className="py-2">Streaming tool input chunk</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">tool_output_chunk</code></td>
                    <td className="py-2">Streaming tool output chunk</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">tool_result</code></td>
                    <td className="py-2">Tool execution result</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">message_complete</code></td>
                    <td className="py-2">Turn complete with full message + attachments</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">confirmation_request</code></td>
                    <td className="py-2">User approval needed before action executes</td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4"><code className="text-xs">generation_handoff</code></td>
                    <td className="py-2">Sub-agent handoff</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4"><code className="text-xs">generation_cancelled</code></td>
                    <td className="py-2">Run cancelled</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section id="connection-management" className="mt-6">
            <SectionHeading id="connection-management" level={3}>
              Connection Management
            </SectionHeading>
            <ul className="mb-4 list-disc space-y-2 pl-6 text-zinc-600">
              <li><strong>Capacity</strong> — up to 100 concurrent SSE connections; oldest evicted when cap is reached</li>
              <li><strong>Slow consumers</strong> — connections closed when receive buffer hits 16 queued events</li>
              <li><strong>Disconnect cleanup</strong> — closing the tab, cancelling the reader, or aborting the request all dispose the subscription deterministically</li>
            </ul>
          </section>

          <section id="javascript-example" className="mt-6">
            <SectionHeading id="javascript-example" level={3}>
              JavaScript Example
            </SectionHeading>
            <p className="mb-4 text-zinc-600">
              The standard <code className="text-sm">EventSource</code> API doesn&apos;t support custom headers, so use <code className="text-sm">fetch()</code> with manual SSE parsing:
            </p>
            <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`const TOKEN = '<jwt>';
const res = await fetch(
  'http://localhost:3001/v1/events?conversationKey=my-conversation',
  { headers: { Authorization: \`Bearer \${TOKEN}\` } },
);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split('\\n\\n');
  buf = frames.pop() ?? '';

  for (const frame of frames) {
    const dataLine = frame.split('\\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice(6));
    console.log(event.message.type, event.message);
  }
}`}
            </pre>
          </section>
        </section>

        {/* Remote Access */}
        <section id="remote-access" className="mt-12">
          <SectionHeading id="remote-access" level={2}>
            Remote Access
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Access a remote assistant from your local machine via SSH port forwarding.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`# CLI
ssh -L 8741:localhost:8741 user@remote-host -N &
VELLUM_DAEMON_URL=http://localhost:8741 vellum

# macOS app
ssh -L 8741:localhost:8741 user@remote-host -N &
VELLUM_DAEMON_URL=http://localhost:8741 open -a Vellum`}
          </pre>
          <p className="mb-4 text-zinc-600">
            Autostart is disabled by default for remote connections. Set <code className="text-sm">VELLUM_DAEMON_AUTOSTART=1</code> to override.
          </p>

          <section id="remote-troubleshooting" className="mt-6">
            <SectionHeading id="remote-troubleshooting" level={3}>
              Troubleshooting
            </SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-700">
                    <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Symptom</th>
                    <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">Check</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-600 dark:text-zinc-400">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4">&ldquo;could not connect to assistant&rdquo;</td>
                    <td className="py-2">Is the SSH tunnel active? Check <code className="text-xs">VELLUM_DAEMON_URL</code></td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4">Assistant starts locally despite remote override</td>
                    <td className="py-2">Check that <code className="text-xs">VELLUM_DAEMON_AUTOSTART</code> is not set to <code className="text-xs">1</code></td>
                  </tr>
                  <tr className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 pr-4">macOS app not connecting</td>
                    <td className="py-2">Verify the assistant URL is reachable</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">&ldquo;connection refused&rdquo;</td>
                    <td className="py-2">Is the remote assistant running? (<code className="text-xs">vellum ps</code>)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm text-zinc-500">
              Run <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">vellum doctor</code> for a full diagnostic check.
            </p>
          </section>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
