#!/usr/bin/env bun

/**
 * Outlook Calendar CLI script with subcommands for calendar operations.
 * Subcommands: list, get, create, availability, rsvp
 */

import {
  parseArgs,
  printError,
  ok,
  requireArg,
  optionalArg,
  parseCsv,
} from "./lib/common.js";
import {
  listEvents,
  getEvent,
  createEvent,
  getSchedule,
  rsvpEvent,
  getMyEmail,
  type OutlookCalendarEvent,
} from "./lib/outlook-cal-client.js";

// ---------------------------------------------------------------------------
// UI confirmation helper
// ---------------------------------------------------------------------------

/**
 * Request user confirmation via `assistant ui confirm`.
 * Blocks until the user approves, denies, or the request times out.
 */
async function requestConfirmation(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const args = [
    "assistant",
    "ui",
    "confirm",
    "--title",
    opts.title,
    "--message",
    opts.message,
    "--confirm-label",
    opts.confirmLabel ?? "Confirm",
    "--json",
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const result = JSON.parse(stdout);
    return result.ok === true && result.confirmed === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage: outlook-cal.ts <subcommand> [options]

Subcommands:
  list          List calendar events
  get           Get a single event by ID
  create        Create a new calendar event
  availability  Check free/busy availability
  rsvp          Accept, decline, or tentatively accept an event

Run with <subcommand> --help for subcommand-specific options.`);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function list(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-cal.ts list [options]

Options:
  --calendar-id  Calendar ID (default: primary calendar)
  --time-min     Start of time range (ISO 8601, default: now)
  --time-max     End of time range (ISO 8601)
  --max-results  Maximum number of events to return (default: 25, max: 250)
  --query        OData $filter expression to append
  --order-by     OData $orderby expression
  --account      Outlook account to use`);
    return;
  }

  const calendarId = optionalArg(args, "calendar-id");
  const timeMin = optionalArg(args, "time-min") ?? new Date().toISOString();
  const timeMax = optionalArg(args, "time-max");
  const maxResults = Math.min(
    parseInt(optionalArg(args, "max-results") ?? "25", 10),
    250,
  );
  const query = optionalArg(args, "query");
  const orderBy = optionalArg(args, "order-by");
  const account = optionalArg(args, "account");

  // Build OData $filter from time range and optional user query
  const filterParts: string[] = [];
  if (timeMin) {
    filterParts.push(`start/dateTime ge '${timeMin}'`);
  }
  if (timeMax) {
    filterParts.push(`start/dateTime le '${timeMax}'`);
  }
  if (query) {
    filterParts.push(query);
  }
  const filter = filterParts.length > 0 ? filterParts.join(" and ") : undefined;

  const result = await listEvents(calendarId, {
    filter,
    top: maxResults,
    orderby: orderBy,
    account,
  });

  if (!result.ok) {
    printError(`Failed to list events: status ${result.status}`);
    return;
  }

  if (!result.data.value?.length) {
    ok("No events found in the specified time range.");
    return;
  }

  ok(JSON.stringify(result.data, null, 2));
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function get(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-cal.ts get --event-id <id>

Options:
  --event-id  Event ID (required)
  --account   Outlook account to use`);
    return;
  }

  const eventId = requireArg(args, "event-id");
  const account = optionalArg(args, "account");

  const result = await getEvent(eventId, undefined, account);

  if (!result.ok) {
    printError(`Failed to get event: status ${result.status}`);
    return;
  }

  ok(JSON.stringify(result.data, null, 2));
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function create(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-cal.ts create --summary <text> --start <datetime> --end <datetime>

Options:
  --summary       Event title (required)
  --start         Start date/time in ISO 8601 (required)
  --end           End date/time in ISO 8601 (required)
  --description   Event description
  --location      Event location
  --attendees     Comma-separated list of attendee email addresses
  --timezone      IANA timezone (e.g. America/New_York)
  --calendar-id   Calendar ID (default: primary calendar)
  --account       Outlook account to use
  --skip-confirm  Skip the interactive confirmation prompt`);
    return;
  }

  const summary = requireArg(args, "summary");
  const startRaw = requireArg(args, "start");
  const endRaw = requireArg(args, "end");
  const description = optionalArg(args, "description");
  const location = optionalArg(args, "location");
  const attendeesRaw = optionalArg(args, "attendees");
  const timezone = optionalArg(args, "timezone");
  const calendarId = optionalArg(args, "calendar-id");
  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  const attendeesList = attendeesRaw ? parseCsv(attendeesRaw) : [];

  // Gate on user confirmation unless explicitly skipped
  if (!skipConfirm) {
    const messageParts = [
      `Event: ${summary}`,
      `Start: ${startRaw}`,
      `End: ${endRaw}`,
    ];
    if (attendeesList.length > 0) {
      messageParts.push(`Attendees: ${attendeesList.join(", ")}`);
    }
    if (location) {
      messageParts.push(`Location: ${location}`);
    }

    const confirmed = await requestConfirmation({
      title: "Create calendar event",
      message: messageParts.join("\n"),
      confirmLabel: "Create",
    });

    if (!confirmed) {
      ok({ created: false, reason: "User did not confirm" });
      return;
    }
  }

  // Detect all-day events: if start string does not contain "T", treat as all-day
  const isAllDay = !startRaw.includes("T");

  // Determine the timeZone to send. If the caller provided an explicit IANA
  // timezone, always use it.  Otherwise, only fall back to UTC when the
  // dateTime string does NOT already carry an offset (e.g. "-05:00" or "Z").
  // Sending timeZone: "UTC" alongside a dateTime that contains a different
  // offset would cause Microsoft Graph to ignore the offset and interpret the
  // time as UTC, creating events at the wrong wall-clock time.
  const hasOffset = (dt: string) => /[Zz]|[+-]\d{2}:\d{2}$/.test(dt);
  const resolveTimeZone = (dt: string) =>
    timezone ?? (hasOffset(dt) ? undefined : "UTC");

  const start = isAllDay
    ? {
        dateTime: `${startRaw}T00:00:00`,
        timeZone: timezone ?? "UTC",
      }
    : { dateTime: startRaw, timeZone: resolveTimeZone(startRaw) };

  const end = isAllDay
    ? {
        dateTime: `${endRaw}T00:00:00`,
        timeZone: timezone ?? "UTC",
      }
    : { dateTime: endRaw, timeZone: resolveTimeZone(endRaw) };

  const eventBody: Partial<OutlookCalendarEvent> = {
    subject: summary,
    start,
    end,
    isAllDay,
  };

  if (description) {
    eventBody.body = { contentType: "text", content: description };
  }
  if (location) {
    eventBody.location = { displayName: location };
  }
  if (attendeesList.length > 0) {
    eventBody.attendees = attendeesList.map((email) => ({
      emailAddress: { address: email },
      type: "required" as const,
    }));
  }

  const result = await createEvent(eventBody, calendarId, account);

  if (!result.ok) {
    printError(`Failed to create event: status ${result.status}`);
    return;
  }

  const event = result.data;
  const webLink = event.webLink
    ? ` View it here: ${event.webLink}`
    : "";
  ok(`Event created (ID: ${event.id}).${webLink}`);
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

async function availability(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-cal.ts availability --time-min <datetime> --time-max <datetime>

Options:
  --time-min   Start of time range (ISO 8601, required)
  --time-max   End of time range (ISO 8601, required)
  --schedules  Comma-separated list of email addresses to check
  --timezone   IANA timezone (default: UTC)
  --account    Outlook account to use`);
    return;
  }

  const timeMin = requireArg(args, "time-min");
  const timeMax = requireArg(args, "time-max");
  const schedulesRaw = optionalArg(args, "schedules");
  const timezone = optionalArg(args, "timezone") ?? "UTC";
  const account = optionalArg(args, "account");

  let schedules = schedulesRaw ? parseCsv(schedulesRaw) : [];

  // Auto-resolve: if no schedules provided, use the authenticated user's email
  if (schedules.length === 0) {
    try {
      const email = await getMyEmail(account);
      schedules = [email];
    } catch {
      // getMyEmail failed — fall through to the check below
    }
  }

  if (schedules.length === 0) {
    printError(
      "No schedules provided and could not determine your email address from your Microsoft profile. " +
        "Please provide at least one email address via --schedules.",
    );
    return;
  }

  const result = await getSchedule(
    {
      schedules,
      startTime: { dateTime: timeMin, timeZone: timezone },
      endTime: { dateTime: timeMax, timeZone: timezone },
    },
    account,
  );

  if (!result.ok) {
    printError(`Failed to check availability: status ${result.status}`);
    return;
  }

  ok(JSON.stringify(result.data, null, 2));
}

// ---------------------------------------------------------------------------
// rsvp
// ---------------------------------------------------------------------------

async function rsvp(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args["help"]) {
    console.log(`Usage: outlook-cal.ts rsvp --event-id <id> --response <accepted|declined|tentative>

Options:
  --event-id   Event ID (required)
  --response   One of: accepted, declined, tentative (required)
  --account    Outlook account to use`);
    return;
  }

  const eventId = requireArg(args, "event-id");
  const response = requireArg(args, "response");
  const account = optionalArg(args, "account");

  // Validate response value
  const validResponses = ["accepted", "declined", "tentative"];
  if (!validResponses.includes(response)) {
    printError(
      `Invalid response: "${response}". Must be one of: ${validResponses.join(", ")}`,
    );
    return;
  }

  // First GET the event to check if user is organizer
  const eventResult = await getEvent(eventId, undefined, account);

  if (!eventResult.ok) {
    printError(`Failed to get event: status ${eventResult.status}`);
    return;
  }

  const event = eventResult.data;

  // If the user is the organizer, no RSVP is needed
  if (event.responseStatus?.response === "organizer") {
    ok("You are the organizer of this event. No RSVP needed.");
    return;
  }

  // Send RSVP via the dedicated Microsoft Graph endpoint with sendResponse: true
  const rsvpResult = await rsvpEvent(
    eventId,
    response as "accepted" | "declined" | "tentative",
    true,
    undefined,
    account,
  );

  if (!rsvpResult.ok) {
    printError(`Failed to RSVP: status ${rsvpResult.status}`);
    return;
  }

  const responseLabel =
    response === "accepted"
      ? "Accepted"
      : response === "declined"
        ? "Declined"
        : "Tentatively accepted";
  ok(`${responseLabel} the event "${event.subject ?? eventId}".`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  switch (command) {
    case "list":
      await list(process.argv.slice(3));
      break;
    case "get":
      await get(process.argv.slice(3));
      break;
    case "create":
      await create(process.argv.slice(3));
      break;
    case "availability":
      await availability(process.argv.slice(3));
      break;
    case "rsvp":
      await rsvp(process.argv.slice(3));
      break;
    default:
      printError(`Unknown subcommand: ${command}. Use --help for usage.`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    printError(err instanceof Error ? err.message : String(err));
  });
}
