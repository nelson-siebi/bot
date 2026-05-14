import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

function isPaidStatus(status: string): boolean {
  return [
    "paid",
    "success",
    "successful",
    "completed",
    "approved",
    "succeeded",
  ].includes(status.toLowerCase());
}

function extractPayloadValue(payload: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = key
      .split(".")
      .reduce((acc: any, part: string) => acc?.[part], payload);
    if (value !== undefined && value !== null && String(value).trim())
      return String(value);
  }
  return null;
}

/**
 * Recursively scan the payload for any value that looks like a reference.
 * This catches unknown Nelsius payload formats.
 */
function findAnyReferenceLike(payload: any, depth = 0): string | null {
  if (depth > 5 || payload == null) return null;

  // Direct string values that look like references
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (
      trimmed.length > 8 &&
      (trimmed.startsWith("DEPOSIT_") ||
        trimmed.startsWith("SUBSCRIPTION_") ||
        trimmed.startsWith("PREMIUM_") ||
        trimmed.startsWith("PRO_PLUS_") ||
        trimmed.startsWith("WALLET_") ||
        /^[A-Z_]+_\d+_\d+$/.test(trimmed))
    ) {
      return trimmed;
    }
    return null;
  }

  // Arrays: scan each element
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findAnyReferenceLike(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Objects: check all values
  for (const val of Object.values(payload)) {
    const found = findAnyReferenceLike(val, depth + 1);
    if (found) return found;
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Nelsius webhook OK", { status: 200 });
  }

  const webhookSecret = Deno.env.get("NELSIUS_WEBHOOK_SECRET") || "";
  if (webhookSecret) {
    const incomingSecret =
      req.headers.get("x-nelsius-secret") ||
      req.headers.get("x-webhook-secret") ||
      "";
    if (incomingSecret !== webhookSecret) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized webhook" }),
        { status: 401 },
      );
    }
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let payload: any;
  try {
    payload = await req.json();
  } catch (_e) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid JSON" }),
      { status: 400 },
    );
  }

  // Extract all possible identifiers from the webhook payload
  // session_id is the most reliable (same in create response AND webhook)
  const sessionId = extractPayloadValue(payload, [
    "session_id",
    "data.session_id",
  ]);
  const reference = extractPayloadValue(payload, [
    "reference",
    "reference_id",
    "data.reference",
    "data.reference_id",
    "payment.reference",
    "payment.reference_id",
    "transaction.reference",
    "transaction.reference_id",
    "data.id",
    "id",
    "session_id",
    "data.session_id",
    "charge_id",
    "data.charge_id",
    "transaction_code",
    "data.transaction_code",
    "operator_transaction_id",
    "data.operator_transaction_id",
  ]);
  const status =
    extractPayloadValue(payload, [
      "status",
      "data.status",
      "payment.status",
      "transaction.status",
      "event",
      "data.event",
    ]) || "unknown";
  const externalId = extractPayloadValue(payload, [
    "id",
    "data.id",
    "transaction_code",
    "data.transaction_code",
    "charge_id",
    "session_id",
    "data.charge_id",
    "data.session_id",
    "data.operator_transaction_id",
    "operator_transaction_id",
    "reference_id",
    "data.reference_id",
  ]);
  const payerPhone = extractPayloadValue(payload, [
    "payer_phone",
    "data.payer_phone",
    "phone",
    "data.phone",
    "customer.phone",
    "data.customer.phone",
  ]);
  const payerEmail = extractPayloadValue(payload, [
    "payer_email",
    "data.payer_email",
    "email",
    "data.email",
    "customer.email",
    "data.customer.email",
  ]);
  const webhookAmount = parseFloat(
    extractPayloadValue(payload, [
      "amount",
      "data.amount",
      "payment.amount",
      "transaction.amount",
    ]) || "0",
  );

  console.log(
    "[Nelsius Webhook] reference:",
    reference,
    "externalId:",
    externalId,
    "sessionId:",
    sessionId,
    "payerPhone:",
    payerPhone,
    "amount:",
    webhookAmount,
  );

  // Log incoming payload for debugging
  console.log(
    "[Nelsius Webhook] Payload received:",
    JSON.stringify(payload).slice(0, 2000),
  );

  // ── Strategy 0: Find payment by session_id (most reliable) ──────────
  let payment: any = null;
  let paymentError: any = null;

  if (sessionId) {
    // Check by external_id (where we stored session_id at creation)
    const result = await supabase
      .from("payments")
      .select("*")
      .eq("external_id", sessionId)
      .maybeSingle();
    payment = result.data;
    paymentError = result.error;

    if (payment) {
      console.log("[Nelsius Webhook] Found payment by session_id:", sessionId);
    }
  }

  // ── Strategy 1: Find payment by reference ────────────────────────────
  if (!payment && reference) {
    // Try matching by reference field
    const result = await supabase
      .from("payments")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();
    payment = result.data;
    paymentError = result.error;

    if (!payment) {
      // Try matching by external_id (in case Nelsius returned our ref as external_id)
      const fallback = await supabase
        .from("payments")
        .select("*")
        .eq("external_id", reference)
        .maybeSingle();
      payment = fallback.data;
      paymentError = fallback.error;
    }
  }

  // ── Strategy 2: Find payment by external_id ──────────────────────────
  if (!payment && externalId) {
    const fallback = await supabase
      .from("payments")
      .select("*")
      .eq("external_id", externalId)
      .maybeSingle();
    payment = fallback.data;
    paymentError = fallback.error;

    if (!payment) {
      // Also try by reference in case external_id is our reference
      const fallback2 = await supabase
        .from("payments")
        .select("*")
        .eq("reference", externalId)
        .maybeSingle();
      if (fallback2.data) {
        payment = fallback2.data;
        paymentError = fallback2.error;
      }
    }
  }

  // ── Strategy 3: Recursive scan for reference-like strings in payload ─
  if (!payment) {
    const foundRef = findAnyReferenceLike(payload);
    if (foundRef) {
      console.log(
        "[Nelsius Webhook] Found reference-like string in payload:",
        foundRef,
      );
      const result = await supabase
        .from("payments")
        .select("*")
        .eq("reference", foundRef)
        .maybeSingle();
      if (result.data) {
        payment = result.data;
        paymentError = result.error;
        console.log(
          "[Nelsius Webhook] Found payment by recursive scan:",
          foundRef,
        );
      }
    }
  }

  // ── Strategy 4: Search pending payments by raw_payload (the create checkout response) ─
  if (!payment) {
    // Check if any pending/created payment has our reference or external_id
    // stored somewhere in its raw_payload JSONB
    const { data: pendingPayments } = await supabase
      .from("payments")
      .select(
        "id, reference, external_id, amount, user_id, raw_payload, created_at",
      )
      .in("status", ["created", "pending"])
      .order("created_at", { ascending: false })
      .limit(20);

    if (pendingPayments && pendingPayments.length > 0) {
      console.log(
        "[Nelsius Webhook] Checking",
        pendingPayments.length,
        "pending payments...",
      );

      const searchValues = [reference, externalId].filter(
        (v): v is string => v !== null && v !== undefined,
      );

      for (const pp of pendingPayments) {
        // Check by amount match (if amount is close enough)
        const dbAmount = Math.round(Number(pp.amount) || 0);
        const whAmount = Math.round(webhookAmount);
        const amountMatch = whAmount > 0 && Math.abs(dbAmount - whAmount) <= 1;

        // Check if any search value appears in the raw_payload JSON
        let payloadMatch = false;
        if (searchValues.length > 0 && pp.raw_payload) {
          const rawStr = JSON.stringify(pp.raw_payload);
          payloadMatch = searchValues.some((v) => rawStr.includes(v));
        }

        if (amountMatch && payloadMatch) {
          payment = pp;
          paymentError = null;
          console.log(
            "[Nelsius Webhook] Found payment by raw_payload+amount:",
            pp.id,
            "ref:",
            pp.reference,
          );
          break;
        }
      }
    }
  }

  if (paymentError) {
    return new Response(
      JSON.stringify({ success: false, error: paymentError.message }),
      { status: 500 },
    );
  }

  if (!payment) {
    console.log(
      "[Nelsius Webhook] Payment not found. reference:",
      reference,
      "externalId:",
      externalId,
    );
    return new Response(
      JSON.stringify({ success: false, error: "Payment not found" }),
      { status: 404 },
    );
  }

  const incomingPaid = isPaidStatus(status);
  const wasAlreadyPaid = isPaidStatus(String(payment.status || ""));

  const updatePayload: Record<string, unknown> = {
    status,
    raw_payload: payload,
    external_id: externalId,
  };

  if (incomingPaid && !payment.paid_at)
    updatePayload.paid_at = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("payments")
    .update(updatePayload)
    .eq("id", payment.id);

  if (updateError) {
    return new Response(
      JSON.stringify({ success: false, error: updateError.message }),
      { status: 500 },
    );
  }

  if (!incomingPaid || wasAlreadyPaid) {
    return new Response(
      JSON.stringify({
        success: true,
        message: wasAlreadyPaid
          ? "Payment already processed"
          : "Payment status recorded",
      }),
    );
  }

  if (payment.payment_type === "subscription") {
    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 1);
    const requestedPlan =
      payment.metadata?.plan === "pro_plus" ? "pro_plus" : "premium";
    const walletToDeduct = Number(payment.metadata?.wallet_to_deduct || 0);

    let userUpdate: Record<string, unknown> = {
      plan: requestedPlan,
      plan_expires_at: end.toISOString(),
      is_active: true,
    };

    if (walletToDeduct > 0) {
      const { data: user } = await supabase
        .from("app_users")
        .select("wallet_balance")
        .eq("id", payment.user_id)
        .maybeSingle();
      const currentBalance = Number(user?.wallet_balance || 0);
      const balanceAfter = Math.max(0, currentBalance - walletToDeduct);
      userUpdate.wallet_balance = balanceAfter;
      await supabase.from("wallet_transactions").insert({
        user_id: payment.user_id,
        payment_id: payment.id,
        type: "subscription",
        amount: -walletToDeduct,
        currency: payment.currency,
        balance_after: balanceAfter,
        description: `Part wallet abonnement ${requestedPlan}`,
      });
    }

    await supabase
      .from("app_users")
      .update(userUpdate)
      .eq("id", payment.user_id);

    await supabase.from("subscriptions").insert({
      user_id: payment.user_id,
      provider: "nelsius",
      status: requestedPlan,
      start_at: now.toISOString(),
      end_at: end.toISOString(),
      payment_reference: reference,
    });
  }

  if (payment.payment_type === "deposit") {
    const { data: user } = await supabase
      .from("app_users")
      .select("wallet_balance")
      .eq("id", payment.user_id)
      .maybeSingle();

    const balanceAfter =
      (user?.wallet_balance || 0) + Number(payment.amount || 0);

    await supabase
      .from("app_users")
      .update({ wallet_balance: balanceAfter })
      .eq("id", payment.user_id);

    await supabase.from("wallet_transactions").insert({
      user_id: payment.user_id,
      payment_id: payment.id,
      type: "deposit",
      amount: payment.amount,
      currency: payment.currency,
      balance_after: balanceAfter,
      description: `Dépôt Nelsius Pay ${reference}`,
    });
  }

  return new Response(JSON.stringify({ success: true }));
});
