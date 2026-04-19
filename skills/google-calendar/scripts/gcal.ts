#!/usr/bin/env bun

/**
 * Google Calendar CLI script.
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
  patchEvent,
  freeBusy,
  type CalendarEvent,
  type EventAttendee,
} from "./lib/gcal-client.js";

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
// list
// ---------------------------------------------------------------------------

async function list(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const calendarId = optionalArg(args, "calendar-id") ?? "primary";
  const timeMin = optionalArg(args, "time-min") ?? new Date().toISOString();
  const timeMax = optionalArg(args, "time-max");
  const maxResults = Math.min(
    parseInt(optionalArg(args, "max-results") ?? "25", 10),
    250,
  );
  const query = optionalArg(args, "query");
  const singleEvents =
    optionalArg(args, "single-events") !== "false";
  const orderBy = optionalArg(args, "order-by");
  const account = optionalArg(args, "account");

  const response = await listEvents(calendarId, {
    timeMin,
    timeMax,
    maxResults,
    q: query,
    singleEvents,
    orderBy,
    account,
  });

  if (!response.ok) {
    printError(`Failed to list events: status ${response.status}`);
    return;
  }

  const result = response.data;
  if (!result.items?.length) {
    ok("No events found in the specified time range.");
    return;
  }

  ok(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

async function get(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const eventId = requireArg(args, "event-id");
  const calendarId = optionalArg(args, "calendar-id") ?? "primary";
  const account = optionalArg(args, "account");

  const response = await getEvent(eventId, calendarId, account);

  if (!response.ok) {
    printError(`Failed to get event: status ${response.status}`);
    return;
  }

  ok(JSON.stringify(response.data, null, 2));
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function create(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const summary = requireArg(args, "summary");
  const startRaw = requireArg(args, "start");
  const endRaw = requireArg(args, "end");
  const description = optionalArg(args, "description");
  const location = optionalArg(args, "location");
  const attendeesRaw = optionalArg(args, "attendees");
  const timezone = optionalArg(args, "timezone");
  const calendarId = optionalArg(args, "calendar-id") ?? "primary";
  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  // Gate on user confirmation unless explicitly skipped
  if (!skipConfirm) {
    const messageParts = [
      `Summary: ${summary}`,
      `Start: ${startRaw}`,
      `End: ${endRaw}`,
    ];
    if (attendeesRaw) messageParts.push(`Attendees: ${attendeesRaw}`);
    if (location) messageParts.push(`Location: ${location}`);

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

  // Determine if these are all-day events (date-only) or timed events
  const isAllDay = !startRaw.includes("T");

  const start = isAllDay
    ? { date: startRaw }
    : { dateTime: startRaw, timeZone: timezone };
  const end = isAllDay
    ? { date: endRaw }
    : { dateTime: endRaw, timeZone: timezone };

  const eventBody: Partial<CalendarEvent> = {
    summary,
    start,
    end,
  };

  if (description) eventBody.description = description;
  if (location) eventBody.location = location;
  if (attendeesRaw) {
    eventBody.attendees = parseCsv(attendeesRaw).map((email) => ({ email }));
  }

  const response = await createEvent(eventBody, calendarId, "all", account);

  if (!response.ok) {
    printError(`Failed to create event: status ${response.status}`);
    return;
  }

  const event = response.data;
  const link = event.htmlLink ? ` View it here: ${event.htmlLink}` : "";
  ok(`Event created (ID: ${event.id}).${link}`);
}

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

async function availability(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const timeMin = requireArg(args, "time-min");
  const timeMax = requireArg(args, "time-max");
  const calendarIdsRaw = optionalArg(args, "calendar-ids") ?? "primary";
  const timezone = optionalArg(args, "timezone");
  const account = optionalArg(args, "account");

  const calendarIds = parseCsv(calendarIdsRaw);

  const response = await freeBusy(
    {
      timeMin,
      timeMax,
      timeZone: timezone,
      items: calendarIds.map((id) => ({ id })),
    },
    account,
  );

  if (!response.ok) {
    printError(`Failed to check availability: status ${response.status}`);
    return;
  }

  ok(JSON.stringify(response.data, null, 2));
}

// ---------------------------------------------------------------------------
// rsvp
// ---------------------------------------------------------------------------

async function rsvp(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const eventId = requireArg(args, "event-id");
  const responseStatus = requireArg(args, "response") as
    | "accepted"
    | "declined"
    | "tentative";
  const calendarId = optionalArg(args, "calendar-id") ?? "primary";
  const account = optionalArg(args, "account");
  const skipConfirm = args["skip-confirm"] === true;

  // Validate response value
  const validResponses = ["accepted", "declined", "tentative"];
  if (!validResponses.includes(responseStatus)) {
    printError(
      `Invalid response: "${responseStatus}". Must be one of: accepted, declined, tentative`,
    );
    return;
  }

  // First GET the event to find the user's attendee entry
  const eventResponse = await getEvent(eventId, calendarId, account);

  if (!eventResponse.ok) {
    printError(`Failed to get event: status ${eventResponse.status}`);
    return;
  }

  const event = eventResponse.data;
  const selfAttendee = event.attendees?.find(
    (a: EventAttendee) => a.self,
  );

  if (!selfAttendee) {
    // If the user is the organizer and not in the attendees list,
    // they don't need to RSVP
    if (event.organizer?.self) {
      ok("You are the organizer of this event. No RSVP needed.");
      return;
    }
    ok(
      "Could not find your attendee entry for this event. You may not be invited.",
    );
    return;
  }

  // Gate on user confirmation unless explicitly skipped
  if (!skipConfirm) {
    const currentStatus = selfAttendee.responseStatus ?? "needsAction";
    const messageParts = [
      `Event: ${event.summary ?? eventId}`,
      `Current status: ${currentStatus}`,
      `New response: ${responseStatus}`,
    ];

    const confirmed = await requestConfirmation({
      title: "RSVP to calendar event",
      message: messageParts.join("\n"),
      confirmLabel: "RSVP",
    });

    if (!confirmed) {
      printError("RSVP cancelled by user.");
      return;
    }
  }

  // Update the attendee's response status
  const updatedAttendees = event.attendees!.map((a: EventAttendee) =>
    a.self ? { ...a, responseStatus } : a,
  );

  const patchResponse = await patchEvent(
    eventId,
    { attendees: updatedAttendees },
    calendarId,
    "all",
    account,
  );

  if (!patchResponse.ok) {
    printError(`Failed to RSVP: status ${patchResponse.status}`);
    return;
  }

  const responseLabel =
    responseStatus === "accepted"
      ? "Accepted"
      : responseStatus === "declined"
        ? "Declined"
        : "Tentatively accepted";
  ok(`${responseLabel} the event "${event.summary ?? eventId}".`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    console.log(`Usage: gcal.ts <subcommand> [options]

Subcommands:
  list          List calendar events
  get           Get a single event by ID
  create        Create a new calendar event
  availability  Check free/busy availability
  rsvp          RSVP to a calendar event

Run with <subcommand> --help for subcommand-specific options.`);
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
