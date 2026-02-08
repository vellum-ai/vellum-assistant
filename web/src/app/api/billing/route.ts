import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

import { getDb } from "@/lib/db";

function getStripeClient(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  return new Stripe(secretKey);
}

async function getOrCreateStripeCustomer(
  sql: ReturnType<typeof getDb>,
  username: string
): Promise<string> {
  const userResult = await sql`
    SELECT * FROM users WHERE username = ${username} LIMIT 1
  `;

  if (userResult.length === 0) {
    throw new Error("User not found");
  }

  const user = userResult[0];
  const existingCustomerId = user.stripe_customer_id as string | null;

  if (existingCustomerId) {
    return existingCustomerId;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    metadata: { username },
    email: (user.email as string | null) ?? undefined,
    name: (user.display_name as string | null) ?? undefined,
  });

  await sql`
    UPDATE users
    SET stripe_customer_id = ${customer.id}, updated_at = NOW()
    WHERE username = ${username}
  `;

  return customer.id;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const username = searchParams.get("username");

  if (!username) {
    return NextResponse.json(
      { error: "username is required" },
      { status: 400 }
    );
  }

  try {
    const sql = getDb();
    const customerId = await getOrCreateStripeCustomer(sql, username);
    const stripe = getStripeClient();

    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
      limit: 1,
    });

    const hasPaymentMethod = paymentMethods.data.length > 0;
    const card = hasPaymentMethod ? paymentMethods.data[0].card : null;

    return NextResponse.json({
      has_payment_method: hasPaymentMethod,
      card: card
        ? {
            brand: card.brand,
            last4: card.last4,
            exp_month: card.exp_month,
            exp_year: card.exp_year,
          }
        : null,
    });
  } catch (error: unknown) {
    console.error("Error checking payment method:", error);
    const message = error instanceof Error ? error.message : "Failed to check payment method";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username } = body;

    if (!username) {
      return NextResponse.json(
        { error: "username is required" },
        { status: 400 }
      );
    }

    const sql = getDb();
    const customerId = await getOrCreateStripeCustomer(sql, username);
    const stripe = getStripeClient();

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
    });

    return NextResponse.json({
      client_secret: setupIntent.client_secret,
    });
  } catch (error: unknown) {
    console.error("Error creating setup intent:", error);
    const message = error instanceof Error ? error.message : "Failed to create setup intent";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
