/**
 * `funnel_math` tool — deterministic unit-economics and funnel math (B2B or B2C).
 *
 * The model is unreliable at multi-step arithmetic; this tool does it exactly.
 * Every field is optional — the tool computes whatever the provided inputs allow
 * and reports the rest as "needs input". Rates accept either a fraction (0.12) or
 * a percentage (12); values > 1 are treated as percentages.
 */

import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "@vellumai/plugin-api";
import { RiskLevel } from "@vellumai/plugin-api";

interface FunnelInput {
  period_label?: string;
  marketing_spend?: number;
  paid_spend?: number;
  new_customers?: number;
  leads?: number;
  mqls?: number;
  mql_to_sql_rate?: number;
  sql_to_won_rate?: number;
  acv?: number;
  gross_margin?: number;
  avg_customer_lifetime_months?: number;
  monthly_churn_rate?: number;
  target_revenue?: number;
}

const asRate = (v: number | undefined): number | undefined => {
  if (v === undefined || Number.isNaN(v)) return undefined;
  return v > 1 ? v / 100 : v;
};

const round = (v: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const tool: ToolDefinition = {
  description:
    "Deterministic unit-economics and funnel calculator for any business (B2B or B2C): CAC (blended & paid), LTV, LTV:CAC, payback months, and stage→stage→revenue funnel projections (the lead/MQL/SQL fields map to whatever funnel stages the business uses), with health flags. Use this for any marketing math instead of computing in prose.",
  defaultRiskLevel: RiskLevel.Low,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      period_label: {
        type: "string",
        description: "Label for the period the spend/volume covers, e.g. 'monthly' or 'Q3'. Default 'monthly'.",
      },
      marketing_spend: { type: "number", description: "Total marketing spend for the period (for blended CAC)." },
      paid_spend: { type: "number", description: "Paid-acquisition spend subset (for paid CAC)." },
      new_customers: { type: "number", description: "New customers won in the period (for CAC)." },
      leads: { type: "number", description: "Top-of-funnel leads in the period." },
      mqls: { type: "number", description: "Marketing-qualified leads in the period (drives the projection)." },
      mql_to_sql_rate: { type: "number", description: "MQL→SQL conversion. Fraction (0.12) or percent (12)." },
      sql_to_won_rate: { type: "number", description: "SQL→won conversion. Fraction (0.25) or percent (25)." },
      acv: { type: "number", description: "Average annual contract value per customer." },
      gross_margin: { type: "number", description: "Gross margin. Fraction (0.8) or percent (80). If omitted, assumes 0.80 — override with the real margin (it varies widely: high for software, much lower for ecommerce/retail/hardware)." },
      avg_customer_lifetime_months: { type: "number", description: "Average customer lifetime in months (for LTV)." },
      monthly_churn_rate: { type: "number", description: "Monthly logo churn; lifetime = 1/churn if lifetime not given." },
      target_revenue: { type: "number", description: "Optional new-revenue target; tool back-solves required MQLs." },
    },
  },

  async execute(input: FunnelInput, _ctx: ToolContext): Promise<ToolExecutionResult> {
    const i = input ?? {};
    const period = i.period_label ?? "monthly";
    const gm = asRate(i.gross_margin) ?? 0.8;
    const mqlToSql = asRate(i.mql_to_sql_rate);
    const sqlToWon = asRate(i.sql_to_won_rate);

    const computed: Record<string, number | string> = {};
    const assumptions: string[] = [];
    const needs: string[] = [];
    const flags: string[] = [];

    if (i.gross_margin === undefined) assumptions.push("gross_margin assumed 0.80 — override with the real margin (varies widely by business model)");

    // Lifetime (years) from explicit months or churn.
    let lifetimeYears: number | undefined;
    if (i.avg_customer_lifetime_months !== undefined) {
      lifetimeYears = i.avg_customer_lifetime_months / 12;
    } else {
      const churn = asRate(i.monthly_churn_rate);
      if (churn && churn > 0) {
        lifetimeYears = 1 / churn / 12;
        assumptions.push(`lifetime derived from churn: ${round(1 / churn)} months`);
      }
    }

    // CAC.
    let cacBlended: number | undefined;
    if (i.marketing_spend !== undefined && i.new_customers) {
      cacBlended = i.marketing_spend / i.new_customers;
      computed.cac_blended = round(cacBlended);
    } else if (i.marketing_spend !== undefined && !i.new_customers) {
      needs.push("new_customers (to compute blended CAC)");
    }
    if (i.paid_spend !== undefined && i.new_customers) {
      computed.cac_paid = round(i.paid_spend / i.new_customers);
    }

    // LTV.
    let ltv: number | undefined;
    if (i.acv !== undefined && lifetimeYears !== undefined) {
      ltv = i.acv * gm * lifetimeYears;
      computed.ltv = round(ltv);
    } else if (i.acv !== undefined && lifetimeYears === undefined) {
      needs.push("avg_customer_lifetime_months or monthly_churn_rate (to compute LTV)");
    }

    // LTV:CAC.
    if (ltv !== undefined && cacBlended) {
      const ratio = ltv / cacBlended;
      computed.ltv_to_cac = round(ratio);
      if (ratio < 3) flags.push(`LTV:CAC is ${round(ratio)} (< 3 is unhealthy — acquisition is too expensive or value too low).`);
      else if (ratio > 5) flags.push(`LTV:CAC is ${round(ratio)} (> 5 often means underinvesting — there may be room to spend more on growth).`);
      else flags.push(`LTV:CAC is ${round(ratio)} (healthy 3–5 range).`);
    }

    // Payback (months) = CAC / monthly gross profit per customer.
    if (cacBlended && i.acv !== undefined) {
      const monthlyGrossProfit = (i.acv * gm) / 12;
      const payback = cacBlended / monthlyGrossProfit;
      computed.cac_payback_months = round(payback, 1);
      if (payback > 12) flags.push(`CAC payback is ${round(payback, 1)} months (> 12 strains cash; aim for < 12, ideally < 6).`);
      else flags.push(`CAC payback is ${round(payback, 1)} months (under 12 — solid).`);
    }

    // Funnel projection from MQLs.
    if (i.mqls !== undefined && mqlToSql !== undefined && sqlToWon !== undefined) {
      const sqls = i.mqls * mqlToSql;
      const won = sqls * sqlToWon;
      computed.projected_sqls = round(sqls, 1);
      computed.projected_won = round(won, 1);
      if (i.acv !== undefined) {
        computed.projected_pipeline = round(sqls * i.acv);
        computed.projected_new_revenue = round(won * i.acv);
      } else {
        needs.push("acv (to value pipeline and revenue)");
      }
    } else if (i.mqls !== undefined) {
      needs.push("mql_to_sql_rate and sql_to_won_rate (to project the funnel)");
    }

    // Back-solve required MQLs for a revenue target.
    if (i.target_revenue !== undefined && mqlToSql && sqlToWon && i.acv) {
      const wonNeeded = i.target_revenue / i.acv;
      const sqlsNeeded = wonNeeded / sqlToWon;
      const mqlsNeeded = sqlsNeeded / mqlToSql;
      computed.required_won_for_target = round(wonNeeded, 1);
      computed.required_sqls_for_target = round(sqlsNeeded, 1);
      computed.required_mqls_for_target = Math.ceil(mqlsNeeded);
    } else if (i.target_revenue !== undefined) {
      needs.push("mql_to_sql_rate, sql_to_won_rate, and acv (to back-solve the target)");
    }

    if (Object.keys(computed).length === 0) {
      needs.push("at least one usable combination (e.g. marketing_spend + new_customers, or mqls + conversion rates + acv)");
    }

    const result = {
      period,
      gross_margin_used: gm,
      computed,
      assumptions,
      needs_input: needs,
      flags,
    };

    return { content: JSON.stringify(result, null, 2), isError: false };
  },
};

export default tool;
