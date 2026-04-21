import { sql } from "drizzle-orm";
import { getGatewayDb } from "../../db/connection.js";
import { autoApproveThresholds } from "../../db/schema.js";
import { getLogger } from "../../logger.js";

const log = getLogger("auto-approve-thresholds");

const VALID_THRESHOLDS = ["none", "low", "medium"] as const;
type ThresholdValue = (typeof VALID_THRESHOLDS)[number];

const DEFAULTS = {
  interactive: "low" as ThresholdValue,
  background: "medium" as ThresholdValue,
  headless: "none" as ThresholdValue,
};

function isValidThreshold(value: unknown): value is ThresholdValue {
  return (
    typeof value === "string" &&
    VALID_THRESHOLDS.includes(value as ThresholdValue)
  );
}

export function createThresholdsGetHandler() {
  return async (_req: Request): Promise<Response> => {
    const db = getGatewayDb();
    const rows = db.select().from(autoApproveThresholds).all();
    const row = rows[0];

    if (!row) {
      return Response.json({ ...DEFAULTS });
    }

    return Response.json({
      interactive: row.interactive,
      background: row.background,
      headless: row.headless,
    });
  };
}

export function createThresholdsPutHandler() {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const { interactive, background, headless } = body as {
      interactive?: unknown;
      background?: unknown;
      headless?: unknown;
    };

    const hasInteractive = "interactive" in (body as object);
    const hasBackground = "background" in (body as object);
    const hasHeadless = "headless" in (body as object);

    // Validate provided fields
    if (hasInteractive && !isValidThreshold(interactive)) {
      return Response.json(
        {
          error: `"interactive" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (hasBackground && !isValidThreshold(background)) {
      return Response.json(
        {
          error: `"background" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (hasHeadless && !isValidThreshold(headless)) {
      return Response.json(
        { error: `"headless" must be one of: ${VALID_THRESHOLDS.join(", ")}` },
        { status: 400 },
      );
    }

    const db = getGatewayDb();

    // Read current state to merge with partial updates
    const existingRows = db.select().from(autoApproveThresholds).all();
    const existing = existingRows[0];

    const merged = {
      interactive: hasInteractive
        ? (interactive as ThresholdValue)
        : (existing?.interactive ?? DEFAULTS.interactive),
      background: hasBackground
        ? (background as ThresholdValue)
        : (existing?.background ?? DEFAULTS.background),
      headless: hasHeadless
        ? (headless as ThresholdValue)
        : (existing?.headless ?? DEFAULTS.headless),
    };

    db.insert(autoApproveThresholds)
      .values({
        id: 1,
        interactive: merged.interactive,
        background: merged.background,
        headless: merged.headless,
        updatedAt: sql`datetime('now')`,
      })
      .onConflictDoUpdate({
        target: autoApproveThresholds.id,
        set: {
          interactive: merged.interactive,
          background: merged.background,
          headless: merged.headless,
          updatedAt: sql`datetime('now')`,
        },
      })
      .run();

    log.info(merged, "Auto-approve thresholds updated");

    return Response.json({
      interactive: merged.interactive,
      background: merged.background,
      headless: merged.headless,
    });
  };
}
