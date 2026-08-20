"use client";

import Link from "next/link";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "the-declaration", label: "The declaration", level: 2 },
  { id: "route-fields", label: "Route fields", level: 3 },
  { id: "approval-and-signatures", label: "Approval and signatures", level: 2 },
  { id: "third-party-verification", label: "Third-party verification", level: 2 },
  { id: "inbound-messages", label: "Delivering inbound messages", level: 2 },
  { id: "presentation", label: "Presentation", level: 2 },
  { id: "anatomy-of-a-channel", label: "Anatomy of a channel", level: 2 },
  {
    id: "when-to-write-a-channel",
    label: "When should my assistant write a Channel?",
    level: 2,
  },
];

const linkClass =
  "font-semibold text-emerald-700 underline hover:text-emerald-800";

const ROUTES_PAGE_URL = "/docs/extensibility/routes";
const PLUGIN_API_URL =
  "https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api";

type FieldRow = {
  field: string;
  required: string;
  fallback: string;
  notes: string;
};

const ROUTE_FIELDS: FieldRow[] = [
  {
    field: "path",
    required: "yes",
    fallback: "",
    notes: 'Relative to the plugin\'s own namespace ("events", not /webhooks/plugins/my-plugin/events). No leading slash, no trailing slash, no query or fragment, no . or .. segments, and canonical (unencoded, no empty or redundant segments).',
  },
  {
    field: "kind",
    required: "yes",
    fallback: "",
    notes: '"http" or "websocket". The gateway bridges the two differently, so the kind has to be known before a connection arrives.',
  },
  {
    field: "description",
    required: "yes",
    fallback: "",
    notes: "Human-readable purpose, surfaced in gateway logs and the approval UI.",
  },
  {
    field: "handshake",
    required: "no",
    fallback: '"signed-headers"',
    notes: 'Where the caller carries its signature. "signed-headers" (default) puts it in request headers. "signed-query" puts the same HMAC in the URL, WebSocket only, for a caller that is handed a URL and nothing else.',
  },
  {
    field: "verification",
    required: "no",
    fallback: "vendor HMAC",
    notes: "How a third-party caller's signature is checked. HTTP only.",
  },
  {
    field: "inbound",
    required: "no",
    fallback: "webhook only",
    notes: "That this route's replies carry inbound messages, and how to read them. HTTP only.",
  },
];

export function ExtensibilityChannelsContent() {
  return (
    <>
      <DocsContent
        title="Channels"
        breadcrumb="Docs / Extensibility / Channels"
        subtitle="Make a route reachable from the public internet. A plugin is a channel because it declares ingress: channels/ingress.json is the list of routes the outside world may reach it on."
      >
        <p className="mb-8 text-zinc-600 dark:text-zinc-400">
          The gateway owns the public surface: it validates the declaration,
          signature-checks every request, and holds{" "}
          <code>plugin</code>-signed routes behind a guardian&apos;s approval.
          Plugins that declare a channel ingress are considered themselves a
          channel in all contexts where channels are viewed.
        </p>

        <section id="the-declaration">
          <SectionHeading id="the-declaration" level={2}>
            The declaration
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            <code>channels/ingress.json</code> is a JSON object with a
            non-empty <code>routes</code> array. The plugin&apos;s identity
            comes from its directory, not from the file, so a manifest cannot
            claim to belong to a different plugin. Declare the public path in{" "}
            <code>ingress.json</code> <strong>and</strong> implement the
            matching handler under{" "}
            <Link href={ROUTES_PAGE_URL} className={linkClass}>
              <code>routes/</code>
            </Link>{" "}
            at the same relative path.
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "routes": [
    {
      "path": "events",
      "kind": "http",
      "description": "Inbound events from Example Courier"
    }
  ]
}`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            That route is served at{" "}
            <code>/webhooks/plugins/&lt;plugin-name&gt;/events</code> and
            handled by <code>routes/events.ts</code>. Resolve the URL to
            hand a vendor with{" "}
            <code>resolveWebhookUrl({"{ path: \"events\" }"})</code> from{" "}
            <Link href={PLUGIN_API_URL} className={linkClass}>
              <code>@vellumai/plugin-api</code>
            </Link>
            . Do not hardcode a hostname. Do not tell a vendor to POST at{" "}
            <code>/x/plugins/...</code>.
          </p>

          <div id="route-fields" className="mt-8">
            <SectionHeading id="route-fields" level={3}>
              Route fields
            </SectionHeading>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left dark:border-zinc-700">
                    <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                      Field
                    </th>
                    <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                      Required
                    </th>
                    <th className="py-2 pr-4 font-semibold text-zinc-900 dark:text-zinc-100">
                      Default
                    </th>
                    <th className="py-2 font-semibold text-zinc-900 dark:text-zinc-100">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="text-zinc-600 dark:text-zinc-400">
                  {ROUTE_FIELDS.map((row) => (
                    <tr
                      key={row.field}
                      className="border-b border-zinc-100 align-top dark:border-zinc-800"
                    >
                      <td className="py-2 pr-4">
                        <code>{row.field}</code>
                      </td>
                      <td className="py-2 pr-4">{row.required}</td>
                      <td className="py-2 pr-4">
                        {row.fallback ? <code>{row.fallback}</code> : "none"}
                      </td>
                      <td className="py-2">{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mb-0 mt-4 text-zinc-600 dark:text-zinc-400">
              Duplicate paths in one file fail the whole declaration. A
              malformed file disables ingress for that plugin only; sibling
              plugins keep theirs.
            </p>
          </div>
        </section>

        <section id="approval-and-signatures" className="mt-12">
          <SectionHeading id="approval-and-signatures" level={2}>
            Approval and signatures
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Every public plugin route is signature-checked. An unsigned plugin
            route does not exist. A route whose signing secret is missing is
            refused rather than served unsigned, and an unauthenticated probe
            sees <code>404</code> whether the route is undeclared, pending, or
            missing a secret.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            A guardian has to approve the declaration before the gateway serves
            it. The approval covers a digest of the declaration: adding a
            route, changing transport, handshake, verification, or inbound
            delivery drops the plugin back to pending. Rewording{" "}
            <code>description</code> does not. Editing the file and reinstalling
            is not enough; the guardian has to approve the new digest. Ask the
            user to approve pending ingress from the channels settings once the
            plugin is installed. A plugin must not approve its own ingress.
          </p>
        </section>

        <section id="third-party-verification" className="mt-12">
          <SectionHeading id="third-party-verification" level={2}>
            Third-party verification
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A vendor that signs <code>X-Example-Signature</code> has its own
            scheme. Declare <code>verification</code> so the gateway runs one
            HMAC engine and reads the vendor&apos;s specifics as data:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "path": "events",
  "kind": "http",
  "description": "Inbound deliveries from Example Courier",
  "verification": {
    "kind": "hmac",
    "algorithm": "sha256",
    "secret": { "field": "courier_webhook_secret" },
    "signature": {
      "header": "X-Example-Signature",
      "encoding": "hex",
      "prefix": "sha256="
    },
    "payload": ["body"],
    "freshness": {
      "header": "X-Example-Timestamp",
      "format": "unix-seconds",
      "toleranceSeconds": 300
    }
  }
}`}</code>
          </pre>
          <ul className="mb-0 list-disc space-y-2 pl-6 text-zinc-600 dark:text-zinc-400">
            <li>
              The credential <strong>service</strong> is the plugin&apos;s
              directory name. The descriptor names only a <strong>field</strong>
              . A manifest cannot point a route at another plugin&apos;s secret
              or at the platform&apos;s.
            </li>
            <li>
              Store the secret via <code>assistant credentials prompt</code> (or{" "}
              <code>storeCredential</code> from a hook, tool, or route). Never
              put it in the file.
            </li>
            <li>
              <code>payload</code> is the exact bytes the vendor signs, in
              order: <code>&quot;body&quot;</code>,{" "}
              <code>{`{ "header": "..." }`}</code>, or{" "}
              <code>{`{ "literal": "..." }`}</code>. A header named in{" "}
              <code>payload</code> but absent from the request fails
              verification rather than contributing an empty string.
            </li>
            <li>
              <code>freshness</code> is a replay window. Declare it when the
              vendor binds a timestamp. A signature over the body alone stays
              valid for as long as the secret does.
            </li>
            <li>
              Unrecognized fields fail the declaration rather than guessing a
              scheme.
            </li>
          </ul>
        </section>

        <section id="inbound-messages" className="mt-12">
          <SectionHeading id="inbound-messages" level={2}>
            Delivering inbound messages
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Absent <code>inbound</code>, the route is a webhook and nothing
            more: the gateway forwards the delivery, returns whatever the plugin
            answered, and the message goes no further.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            Present, the plugin&apos;s <strong>reply</strong> is normalized and
            run through the gateway&apos;s inbound pipeline (admission floor,
            trust verdict, verification and invite intercepts), exactly as a
            built-in channel&apos;s would be. The plugin parses the vendor
            payload. The declaration tells the gateway where the sender and the
            conversation sit so the gate can run before anything is forwarded.
          </p>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A plugin that returns the default envelope declares{" "}
            <code>{`"inbound": {}`}</code> and nothing more. The matching route
            handler replies with:
          </p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "message": {
    "content": "hello",
    "conversationExternalId": "chat-123",
    "externalMessageId": "msg-123"
  },
  "actor": {
    "actorExternalId": "+12025550142",
    "displayName": "Alice"
  },
  "source": { "chatType": "dm" }
}`}</code>
          </pre>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            A reply with no sender and no conversation is a plain
            acknowledgement (delivery receipt, vendor probe). Naming some of
            those fields and not the rest is invalid and is logged rather than
            quietly dropped. Override field locations when the vendor&apos;s
            payload is not that shape. Paths are dotted identifiers (
            <code>message.body</code>), not JSONPath. <code>from</code> may list
            several paths (first non-empty wins). <code>map</code> /{" "}
            <code>default</code> turn a vendor vocabulary into ours.{" "}
            <code>identity</code> is <code>opaque</code> (default),{" "}
            <code>phone</code>, or <code>email</code>: it decides whether{" "}
            <code>+1 (202) 555-0142</code> and <code>+12025550142</code> are the
            same person. Leave it <code>opaque</code> unless the sender id
            really is a phone number or email.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            The plugin does not get to name the channel (the gateway stamps{" "}
            <code>plugin</code>) or the external-id namespace (every id is
            prefixed with the plugin&apos;s directory name). A plugin cannot
            inherit Slack&apos;s admission floor or another plugin&apos;s
            contacts.
          </p>
        </section>

        <section id="presentation" className="mt-12">
          <SectionHeading id="presentation" level={2}>
            Presentation
          </SectionHeading>
          <p className="mb-4 text-zinc-600 dark:text-zinc-400">
            The channels list reads the plugin&apos;s <code>package.json</code>,
            not the ingress file. Optional <code>displayName</code>,{" "}
            <code>description</code>, and <code>icon</code> (a Lucide name
            without the <code>lucide-</code> prefix) do not gate load. A plugin
            with ingress and a bare <code>package.json</code> still appears,
            titled from its directory. A plugin whose directory name is already
            a built-in channel (<code>slack</code>, <code>telegram</code>, …) is
            skipped so it cannot impersonate one.
          </p>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Disabled plugins contribute no channel.
          </p>
        </section>

        <section id="anatomy-of-a-channel" className="mt-12">
          <SectionHeading id="anatomy-of-a-channel" level={2}>
            Anatomy of a channel
          </SectionHeading>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`example-courier/
├── package.json
├── channels/
│   └── ingress.json
└── routes/
    └── events.ts`}</code>
          </pre>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`{
  "routes": [
    {
      "path": "events",
      "kind": "http",
      "description": "Inbound events from Example Courier",
      "inbound": {}
    }
  ]
}`}</code>
          </pre>
          <pre className="mb-0 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
            <code>{`// routes/events.ts
export async function POST(request: Request): Promise<Response> {
  const delivery = await request.json();
  return Response.json({
    message: {
      content: delivery.text ?? "",
      conversationExternalId: delivery.chatId,
      externalMessageId: delivery.messageId,
    },
    actor: {
      actorExternalId: delivery.from,
      displayName: delivery.fromName,
    },
  });
}`}</code>
          </pre>
        </section>

        <section id="when-to-write-a-channel" className="mt-12">
          <SectionHeading id="when-to-write-a-channel" level={2}>
            When should my assistant write a Channel?
          </SectionHeading>
          <p className="mb-0 text-zinc-600 dark:text-zinc-400">
            Reach for <code>channels/ingress.json</code> when a third party must
            deliver to the assistant from outside: a vendor webhook, a realtime
            socket a third party dials, or a channel that should appear next to
            Slack and Telegram. Use a{" "}
            <Link href={ROUTES_PAGE_URL} className={linkClass}>
              route
            </Link>{" "}
            alone when the caller is already inside the assistant (an app
            frontend, a local tool, another plugin). After install, hand the
            vendor <code>await resolveWebhookUrl({"{ path: \"events\" }"})</code>{" "}
            and ask the guardian to approve the pending ingress from channels
            settings.
          </p>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
