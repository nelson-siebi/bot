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

  const reference = extractPayloadValue(payload, [
    "reference",
    "reference_id",
    "data.reference",
    "data.reference_id",
    "payment.reference",
    "payment.reference_id",
    "transaction.reference",
    "transaction.reference_id",
  ]);
  const status =
    extractPayloadValue(payload, [
      "status",
      "data.status",
      "payment.status",
      "transaction.status",
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
  ]);

  if (!reference) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing reference" }),
      { status: 400 },
    );
  }

  let { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select("*")
    .eq("reference", reference)
    .maybeSingle();

  if (!payment && reference) {
    const fallback = await supabase
      .from("payments")
      .select("*")
      .eq("external_id", reference)
      .maybeSingle();
    payment = fallback.data;
    paymentError = fallback.error;
  }

  if (!payment && externalId) {
    const fallback = await supabase
      .from("payments")
      .select("*")
      .eq("external_id", externalId)
      .maybeSingle();
    payment = fallback.data;
    paymentError = fallback.error;
  }

  if (paymentError) {
    return new Response(
      JSON.stringify({ success: false, error: paymentError.message }),
      { status: 500 },
    );
  }

  if (!payment) {
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
