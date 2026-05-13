import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const OUTPUT_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "";
const BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Admin IDs: comma-separated Telegram user/chat IDs allowed to control the bot
const ADMIN_IDS = (Deno.env.get("TELEGRAM_ADMIN_IDS") || OUTPUT_CHAT_ID)
  .split(",")
  .map((id: string) => id.trim())
  .filter(Boolean);

function isAdmin(id: number | string): boolean {
  return ADMIN_IDS.includes(String(id));
}

async function getOrCreateAppUser(
  supabase: any,
  telegramUserId: number,
  username?: string,
) {
  const { data: existing, error: selErr } = await supabase
    .from("app_users")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { data: inserted, error: insErr } = await supabase
    .from("app_users")
    .insert({
      telegram_user_id: telegramUserId,
      username: username || null,
      is_admin: false,
    })
    .select("*")
    .maybeSingle();
  if (insErr) throw insErr;
  return inserted;
}

function isPlanActive(user: any, plans: string[]): boolean {
  if (!user || !plans.includes(user.plan)) return false;
  if (!user.plan_expires_at) return true;
  return new Date(user.plan_expires_at).getTime() > Date.now();
}

function isPremium(user: any): boolean {
  return isPlanActive(user, ["premium", "pro_plus"]);
}

function isProPlus(user: any): boolean {
  return isPlanActive(user, ["pro_plus"]);
}

const DEFAULT_FLOW_FILTERS = {
  include_keywords: [],
  exclude_keywords: [],
  block_ads: false,
  media_only: false,
  allow_text: true,
  allow_photos: true,
  allow_videos: true,
  allow_albums: true,
  use_ai_rewrite: false,
  remove_links: false,
  remove_mentions: false,
  signature_text: "",
  translate_enabled: false,
  target_language: "fr",
  replacements: {},
  link_action: "keep",
  link_replacement: "",
};

const USER_HELP = `🤖 <b>Bot Telegram Auto — Espace utilisateur</b>\n\nUtilise les boutons en bas pour gérer ton automatisation Telegram.\n\n<b>Scénario rapide</b>\n1. Clique sur <b>➕ Nouveau flux</b>\n2. Envoie le canal source\n3. Choisis ou ajoute le canal cible\n4. Le bot crée automatiquement le flux\n\n<b>Commandes disponibles</b>\n/addsource &lt;@canal&gt; — Ajouter une source\n/addtarget &lt;@canal ou -100...&gt; — Ajouter une cible\n/addflow &lt;source_id&gt; &lt;target_id&gt; — Créer un flux\n/flows — Mes flux\n/activity — Activité\n/subscribe — Premium`;

function userMenuMarkup() {
  return {
    reply_markup: {
      keyboard: [
        ["➕ Nouveau flux", "🔁 Mes flux"],
        ["⏸ Désactiver flux", "▶️ Réactiver flux"],
        ["📡 Mes sources", "🎯 Mes cibles"],
        ["📊 Activité", "👤 Mon compte"],
        ["💳 Premium", "🚀 Pro Plus"],
        ["💰 Dépôt", "💼 Wallet"],
        ["🧾 Paiements", "⚙️ Filtres Pro+"],
        ["❓ Aide"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function adminMenuMarkup() {
  return {
    reply_markup: {
      keyboard: [
        ["▶️ Lancer agrégation", "📊 Stats"],
        ["➕ Source globale", "📡 Sources globales"],
        ["📰 Articles", "🧹 Nettoyage"],
        ["📣 Notifier utilisateurs"],
        ["❓ Aide admin"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function targetChoiceMarkup(targets: any[]) {
  const keyboard = targets
    .slice(0, 20)
    .map((t) => [
      `🎯 ${shortId(t.id)} - ${(t.title || t.chat_id || "Canal").substring(0, 35)}`,
    ]);
  keyboard.push(["➕ Ajouter une cible", "❌ Annuler"]);
  return {
    reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true },
  };
}

function flowChoiceMarkup(flows: any[]) {
  const keyboard = flows
    .slice(0, 20)
    .map((f) => [
      `🔁 ${shortId(f.id)} - @${f.source?.config?.channel || "source"} → ${f.target?.chat_id || "cible"}`.substring(
        0,
        90,
      ),
    ]);
  keyboard.push(["❌ Annuler"]);
  return {
    reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true },
  };
}

function commandFromButton(label: string): string | null {
  const map: Record<string, string> = {
    "➕ Nouveau flux": "/newflow",
    "🔁 Mes flux": "/flows",
    "⏸ Désactiver flux": "/choosepauseflow",
    "▶️ Réactiver flux": "/chooseresumeflow",
    "📡 Mes sources": "/sources",
    "🎯 Mes cibles": "/targets",
    "📊 Activité": "/activity",
    "👤 Mon compte": "/me",
    "💳 Premium": "/subscribe",
    "🚀 Pro Plus": "/proplus",
    "💰 Dépôt": "/deposit",
    "🧾 Paiements": "/payments",
    "💼 Wallet": "/wallet",
    "⚙️ Filtres Pro+": "/profilters",
    "❓ Aide": "/help",
    "▶️ Lancer agrégation": "/run",
    "📊 Stats": "/stats",
    "➕ Source globale": "/newglobalsource",
    "📡 Sources globales": "/sources",
    "📰 Articles": "/list",
    "🧹 Nettoyage": "/adminclean",
    "🗑 DB seulement": "/deleteall",
    "🔥 Tout supprimer": "/clearall",
    "📣 Notifier utilisateurs": "/broadcast",
    "❓ Aide admin": "/help",
    "✅ J’ai ajouté le bot": "/verifytargetadmin",
    "❌ Annuler": "/cancel",
  };
  return map[label] || null;
}

function shortId(id: string): string {
  return String(id || "").substring(0, 8);
}

function normalizeTelegramChannel(input: string): string {
  let channel = (input || "").trim();
  if (channel.includes("t.me/")) {
    const parts = channel.split("t.me/");
    channel = parts[parts.length - 1].split("/")[0].split("?")[0];
  }
  return channel.replace(/^@/, "").trim().toLowerCase();
}

function normalizeTargetChat(input: string): string {
  const raw = (input || "").trim();
  if (!raw) return "";
  if (raw.startsWith("-100")) return raw;
  const channel = normalizeTelegramChannel(raw);
  return channel ? `@${channel}` : "";
}

function parseKeywordList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 30);
}

function parseOnOff(value: string | undefined): boolean | null {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (["on", "oui", "yes", "true", "1", "actif"].includes(v)) return true;
  if (["off", "non", "no", "false", "0", "inactif"].includes(v)) return false;
  return null;
}

function mergeFilters(current: any, patch: Record<string, unknown>) {
  return { ...DEFAULT_FLOW_FILTERS, ...(current || {}), ...patch };
}

async function findOwnedRecord(
  supabase: any,
  table: string,
  userId: string,
  idPrefix: string,
) {
  if (!idPrefix) return null;
  const { data } = await supabase
    .from(table)
    .select("*")
    .eq("user_id", userId)
    .ilike("id", `${idPrefix}%`)
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function setBotState(
  supabase: any,
  userId: string,
  state: Record<string, unknown>,
) {
  await supabase
    .from("app_users")
    .update({ bot_state: state })
    .eq("id", userId);
}

async function clearBotState(supabase: any, userId: string) {
  await setBotState(supabase, userId, {});
}

async function getOrCreateUserSource(
  supabase: any,
  userId: string,
  rawChannel: string,
) {
  const channel = normalizeTelegramChannel(rawChannel);
  if (!channel) return { data: null, error: "Canal source invalide." };
  const { data: existing } = await supabase
    .from("user_sources")
    .select("*")
    .eq("user_id", userId)
    .eq("type", "telegram")
    .eq("config->>channel", channel)
    .maybeSingle();
  if (existing) {
    if (!existing.is_active)
      await supabase
        .from("user_sources")
        .update({ is_active: true })
        .eq("id", existing.id);
    return { data: { ...existing, is_active: true }, error: null };
  }
  const { data, error } = await supabase
    .from("user_sources")
    .insert({
      user_id: userId,
      type: "telegram",
      config: { channel },
      is_active: true,
    })
    .select("*")
    .maybeSingle();
  return { data, error: error?.message || null };
}

async function getOrCreateUserTarget(
  supabase: any,
  userId: string,
  rawTarget: string,
  title?: string,
) {
  const chatId = normalizeTargetChat(rawTarget);
  if (!chatId) return { data: null, error: "Canal cible invalide." };
  const targetTitle = title || chatId;
  const { data: existing } = await supabase
    .from("user_targets")
    .select("*")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .maybeSingle();
  if (existing) {
    if (!existing.is_active)
      await supabase
        .from("user_targets")
        .update({ is_active: true, title: targetTitle })
        .eq("id", existing.id);
    return {
      data: {
        ...existing,
        is_active: true,
        title: existing.title || targetTitle,
      },
      error: null,
    };
  }
  const { data, error } = await supabase
    .from("user_targets")
    .insert({
      user_id: userId,
      chat_id: chatId,
      title: targetTitle,
      is_active: true,
    })
    .select("*")
    .maybeSingle();
  return { data, error: error?.message || null };
}

async function createFlowForUser(
  supabase: any,
  appUser: any,
  sourceId: string,
  targetId: string,
) {
  const premium = isPremium(appUser);
  if (!premium) {
    const { count } = await supabase
      .from("flows")
      .select("*", { count: "exact", head: true })
      .eq("user_id", appUser.id)
      .eq("is_active", true);
    if ((count || 0) >= 1)
      return {
        data: null,
        error:
          "Le plan gratuit autorise 1 seul flux actif. Passe Premium pour en créer plusieurs.",
      };
  }
  const { data, error } = await supabase
    .from("flows")
    .insert({
      user_id: appUser.id,
      source_id: sourceId,
      target_id: targetId,
      mode: "new_only",
      initial_last_n: 5,
      is_active: true,
      filters: DEFAULT_FLOW_FILTERS,
    })
    .select("id")
    .maybeSingle();
  return { data, error: error?.message || null };
}

async function getBotInfo(): Promise<{ id: number; username: string } | null> {
  try {
    const res = await fetch(`${BASE}/getMe`);
    const data = await res.json();
    if (data.ok && data.result?.id && data.result?.username) {
      return { id: data.result.id, username: data.result.username };
    }
  } catch (e) {
    console.error("[Bot] getMe failed:", e);
  }
  return null;
}

function botAdminUrl(username: string): string {
  const allAdminRights = [
    "change_info",
    "post_messages",
    "edit_messages",
    "delete_messages",
    "invite_users",
    "restrict_members",
    "pin_messages",
    "promote_members",
    "manage_video_chats",
    "manage_chat",
    "manage_topics",
    "post_stories",
    "edit_stories",
    "delete_stories",
  ].join("+");
  return `https://t.me/${username}?startchannel=setup&admin=${allAdminRights}`;
}

async function checkBotAdminInChat(
  targetChatId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const bot = await getBotInfo();
  if (!bot)
    return {
      ok: false,
      reason: "Impossible d'identifier le bot via Telegram.",
    };
  try {
    const res = await fetch(`${BASE}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChatId, user_id: bot.id }),
    });
    const data = await res.json();
    if (!data.ok)
      return {
        ok: false,
        reason:
          data.description || "Le bot n'est pas encore visible dans ce canal.",
      };
    const status = data.result?.status;
    if (status === "administrator" || status === "creator") return { ok: true };
    return {
      ok: false,
      reason: `Statut actuel: ${status || "inconnu"}. Le bot doit être administrateur.`,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

async function createNelsiusCheckout(
  supabase: any,
  appUser: any,
  paymentType: "subscription" | "deposit",
  amount: number,
  plan: "premium" | "pro_plus" = "premium",
  extraMetadata: Record<string, unknown> = {},
) {
  const secretKey = Deno.env.get("NELSIUS_SECRET_KEY") || "";
  if (!secretKey)
    return {
      checkoutUrl: null,
      error: "Clé Nelsius manquante: configure NELSIUS_SECRET_KEY.",
    };

  const bot = await getBotInfo();
  const reference = `${paymentType.toUpperCase()}_${appUser.telegram_user_id}_${Date.now()}`;
  const returnUrl =
    Deno.env.get("NELSIUS_RETURN_URL") ||
    (bot ? `https://t.me/${bot.username}` : "https://t.me/");

  const { data: payment, error: insertError } = await supabase
    .from("payments")
    .insert({
      user_id: appUser.id,
      provider: "nelsius",
      reference,
      amount,
      currency: "XAF",
      status: "created",
      payment_type: paymentType,
      metadata: {
        telegram_user_id: appUser.telegram_user_id,
        plan,
        ...extraMetadata,
      },
    })
    .select("id")
    .maybeSingle();
  if (insertError) return { checkoutUrl: null, error: insertError.message };

  try {
    const res = await fetch(
      `${Deno.env.get("NELSIUS_BASE_URL") || "https://api.nelsius.com"}/api/v1/checkout/sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount,
          currency: "XAF",
          reference,
          return_url: returnUrl,
          customer: {
            name: appUser.username || `Telegram ${appUser.telegram_user_id}`,
          },
        }),
      },
    );
    const data = await res.json();
    const checkoutUrl = data?.data?.checkout_url || data?.checkout_url || null;
    const externalId =
      data?.data?.reference_id ||
      data?.reference_id ||
      data?.data?.transaction_code ||
      data?.transaction_code ||
      data?.data?.id ||
      data?.id ||
      data?.data?.session_id ||
      null;

    await supabase
      .from("payments")
      .update({
        status: data?.success === false ? "failed" : "pending",
        checkout_url: checkoutUrl,
        external_id: externalId,
        raw_payload: data,
      })
      .eq("id", payment.id);

    if (!checkoutUrl)
      return {
        checkoutUrl: null,
        error: data?.message || "Nelsius n'a pas retourné de lien de paiement.",
      };
    return { checkoutUrl, error: null };
  } catch (e) {
    await supabase
      .from("payments")
      .update({
        status: "failed",
        raw_payload: { error: (e as Error).message },
      })
      .eq("id", payment.id);
    return { checkoutUrl: null, error: (e as Error).message };
  }
}

async function activateSubscriptionFromWallet(
  supabase: any,
  appUser: any,
  plan: "premium" | "pro_plus",
  price: number,
) {
  const balance = Number(appUser.wallet_balance || 0);
  if (balance < price) return { activated: false, error: "Solde insuffisant." };
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);
  const balanceAfter = balance - price;

  await supabase
    .from("app_users")
    .update({
      wallet_balance: balanceAfter,
      plan,
      plan_expires_at: end.toISOString(),
      is_active: true,
    })
    .eq("id", appUser.id);

  await supabase.from("wallet_transactions").insert({
    user_id: appUser.id,
    type: "subscription",
    amount: -price,
    currency: "XAF",
    balance_after: balanceAfter,
    description: `Paiement abonnement ${plan === "pro_plus" ? "Pro Plus" : "Premium"} par wallet`,
  });

  await supabase.from("subscriptions").insert({
    user_id: appUser.id,
    provider: "wallet",
    status: plan,
    start_at: now.toISOString(),
    end_at: end.toISOString(),
    payment_reference: `WALLET_${plan.toUpperCase()}_${Date.now()}`,
  });

  return { activated: true, balanceAfter, end: end.toISOString(), error: null };
}

async function prepareSubscriptionPayment(
  supabase: any,
  appUser: any,
  plan: "premium" | "pro_plus",
  price: number,
): Promise<any> {
  const balance = Number(appUser.wallet_balance || 0);
  if (balance >= price)
    return await activateSubscriptionFromWallet(supabase, appUser, plan, price);

  const paymentAmount = Math.max(100, price - balance);
  const walletToDeduct = Math.max(0, price - paymentAmount);
  const result = await createNelsiusCheckout(
    supabase,
    appUser,
    "subscription",
    paymentAmount,
    plan,
    {
      subscription_price: price,
      wallet_to_deduct: walletToDeduct,
    },
  );

  return {
    activated: false,
    checkoutUrl: result.checkoutUrl,
    error: result.error,
    paymentAmount,
    walletToDeduct,
  };
}

async function promptBotAdminSetup(
  chatId: number | string,
  targetChatId: string,
) {
  const bot = await getBotInfo();
  if (bot) {
    await reply(
      chatId,
      `🔐 <b>Autorisation nécessaire</b>\n\nPour publier dans <b>${targetChatId}</b>, ajoute le bot comme administrateur du canal.\n\nClique sur le bouton ci-dessous pour ouvrir Telegram et choisir ton canal.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "➕ Ajouter le bot comme admin",
                url: botAdminUrl(bot.username),
              },
            ],
          ],
        },
      },
    );
  } else {
    await reply(
      chatId,
      `🔐 Ajoute ce bot comme administrateur dans <b>${targetChatId}</b>.`,
    );
  }

  await reply(
    chatId,
    "Quand c'est fait, reviens ici et clique sur <b>✅ J’ai ajouté le bot</b>.",
    {
      reply_markup: {
        keyboard: [["✅ J’ai ajouté le bot"], ["❌ Annuler"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
  );
}

async function reply(
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4096),
        parse_mode: "HTML",
        ...extra,
      }),
    });
    if (!res.ok) console.error("[Bot] sendMessage failed:", await res.text());
  } catch (e) {
    console.error("[Bot] sendMessage exception:", e);
  }
}

async function sendPhotoToChat(
  chatId: number | string,
  photoFileId: string,
  caption: string,
) {
  try {
    const res = await fetch(`${BASE}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoFileId,
        caption: caption.substring(0, 1024),
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) console.error("[Bot] sendPhoto failed:", await res.text());
  } catch (e) {
    console.error("[Bot] sendPhoto exception:", e);
  }
}

async function copyMessageToChat(
  chatId: number | string,
  fromChatId: number | string,
  messageId: number,
  caption?: string,
) {
  const body: any = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  };
  if (caption !== undefined) {
    body.caption = caption.substring(0, 1024);
    body.parse_mode = "HTML";
  }
  try {
    const res = await fetch(`${BASE}/copyMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error("[Bot] copyMessage failed:", data);
    return data;
  } catch (e) {
    console.error("[Bot] copyMessage exception:", e);
    return { ok: false, error: e };
  }
}

async function restructureWithAI(
  rawText: string,
  apiKey: string,
): Promise<{ title: string; content: string; isAd: boolean }> {
  if (!apiKey || !rawText || rawText.length < 5)
    return { title: "", content: rawText, isAd: false };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Tu es un journaliste professionnel et éditeur de nouvelles pour le canal Telegram @izynews.\nVoici une information brute issue d'un canal source :\n\n${rawText}\n\nInstructions :\n1. Analyse très attentivement le texte. S'il s'agit d'une publicité, d'un contenu sponsorisé, d'un appel commercial, de crypto-monnaie promotionnelle ou de spam, mets IMPÉRATIVEMENT "is_ad": true dans le JSON.\n2. Si ce n'est pas une pub, reformule l'information pour qu'elle soit claire, percutante, professionnelle, et attrayante.\n3. Écris un titre court et captivant (max 100 caractères), TOUJOURS bien stylisé et agrémenté de PLUSIEURS émojis (stickers) variés en rapport direct avec la situation pour attirer l'oeil.\n4. Intègre ce titre tout en haut du contenu reformulé, en le mettant en gras avec des balises HTML (<b>Titre</b>).\n5. Ajoute des émojis pertinents tout au long du texte pour aérer la lecture.\n6. Conserve les détails importants (dates, lieux, personnes).\n7. Ne mets PAS "@izynews" à la fin, je le ferai programmatiquement.\n\nRéponds UNIQUEMENT au format JSON strict suivant :\n{\n  "is_ad": false,\n  "title": "Titre stylisé avec emojis 🚀",\n  "content": "<b>Titre stylisé avec emojis 🚀</b>\\n\\nContenu reformulé ici avec des émojis... ✅"\n}`,
                },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      },
    );
    const data = await res.json();
    const textResp = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (textResp) {
      let jsonStr = textResp.trim();
      const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        jsonStr = match[1].trim();
      }
      const parsed = JSON.parse(jsonStr);
      return {
        title: parsed.title || "",
        content: parsed.content || rawText,
        isAd: parsed.is_ad === true,
      };
    }
  } catch (e) {
    console.error("[Gemini] Error:", e);
  }
  return { title: "", content: rawText, isAd: false };
}

// ── HELP TEXT ─────────────────────────────────────────────────────────────────
const HELP = `🤖 <b>Bot Admin — Gestion des infos</b>\n\n<b>📰 Articles</b>\n/list [n] — Derniers articles (défaut: 10, max: 20)\n/article &lt;id&gt; — Voir un article\n/delete &lt;id&gt; — Supprimer un article\n/deleteall — Supprimer TOUS les articles (DB seulement)\n/clearall — Supprimer TOUT (canal Telegram + DB + reset sources)\n/clearall force — Supprimer les 100 derniers messages du canal (nucléaire)\n/publish &lt;texte&gt; — Publier un article (texte)\n  ↳ Envoie une photo avec /publish en légende pour publier avec image\n\n<b>📡 Sources Telegram</b>\n/sources — Liste des sources actives\n/addsource &lt;@canal ou URL&gt; — Ajouter un canal Telegram\n/delsource &lt;id&gt; — Désactiver une source\n\n<b>⚙️ Système</b>\n/run — Lancer l'agrégation maintenant\n/stats — Statistiques de la plateforme\n/help — Afficher ce message`;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Telegram Bot Webhook — OK", { status: 200 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = (body.message || body.edited_message) as
    | Record<string, unknown>
    | undefined;
  if (!message) return new Response("OK", { status: 200 });

  const chatId = (message.chat as any)?.id as number;
  const userId = (message.from as any)?.id as number;
  const username =
    ((message.from as any)?.username as string | undefined) || undefined;
  const messageId = message.message_id as number;
  const text = ((message.text || message.caption || "") as string).trim();
  const photo = (message.photo as any[]) || null;
  const hasMedia = !!(
    photo ||
    message.video ||
    message.document ||
    message.audio ||
    message.animation ||
    message.voice
  );

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const adminMode = isAdmin(chatId) || isAdmin(userId);
  const buttonCommand = commandFromButton(text);
  const normalizedText = buttonCommand || text;
  const parts = normalizedText.split(/\s+/);
  const command = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  try {
    // ── Ensure app user exists for every Telegram user, including admins ──
    let appUser: any = await getOrCreateAppUser(supabase, userId, username);
    if (adminMode && !appUser.is_admin) {
      await supabase
        .from("app_users")
        .update({ is_admin: true })
        .eq("id", appUser.id);
      appUser = { ...appUser, is_admin: true };
    }

    if (adminMode && command === "/broadcast") {
      await setBotState(supabase, appUser.id, {
        step: "admin_broadcast_input",
        draft: {},
      });
      await reply(
        chatId,
        "📣 <b>Notification utilisateurs</b>\n\nEnvoie maintenant le message à diffuser à tous les utilisateurs actifs du bot.\n\nLe bot ajoutera automatiquement: <code>Salut cher/chère {nom},</code>",
        {
          reply_markup: {
            keyboard: [["❌ Annuler"]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
      return new Response("OK", { status: 200 });
    }

    if (
      adminMode &&
      appUser.bot_state?.step === "admin_broadcast_input" &&
      !buttonCommand &&
      !text.startsWith("/")
    ) {
      const messageToSend = text.trim();
      if (!messageToSend) {
        await reply(
          chatId,
          "❌ Message vide. Envoie un message ou clique sur Annuler.",
        );
        return new Response("OK", { status: 200 });
      }

      const { data: users, error } = await supabase
        .from("app_users")
        .select("telegram_user_id, username, is_active")
        .eq("is_active", true);

      if (error) {
        await clearBotState(supabase, appUser.id);
        await reply(
          chatId,
          `❌ Erreur récupération utilisateurs: ${error.message}`,
          adminMenuMarkup(),
        );
        return new Response("OK", { status: 200 });
      }

      let sent = 0;
      let failed = 0;
      for (const u of users || []) {
        const name = u.username ? `@${u.username}` : "utilisateur";
        try {
          await reply(
            u.telegram_user_id,
            `Salut cher/chère ${name},\n\n${messageToSend}`,
          );
          sent++;
          await new Promise((r) => setTimeout(r, 80));
        } catch (_e) {
          failed++;
        }
      }
      await clearBotState(supabase, appUser.id);
      await reply(
        chatId,
        `✅ Notification envoyée.\nEnvoyés: <b>${sent}</b>\nÉchecs: <b>${failed}</b>`,
        adminMenuMarkup(),
      );
      return new Response("OK", { status: 200 });
    }

    if (adminMode && command === "/newglobalsource") {
      await setBotState(supabase, appUser.id, {
        step: "admin_global_source_input",
        draft: {},
      });
      await reply(
        chatId,
        "➕ <b>Nouvelle source globale</b>\n\nEnvoie le canal Telegram source à ajouter au système global.\n\nExemple: <code>@canal_source</code> ou <code>https://t.me/canal_source</code>",
        {
          reply_markup: {
            keyboard: [["❌ Annuler"]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
      return new Response("OK", { status: 200 });
    }

    if (
      adminMode &&
      appUser.bot_state?.step === "admin_global_source_input" &&
      !buttonCommand &&
      !text.startsWith("/")
    ) {
      const channel = normalizeTelegramChannel(text);
      if (!channel) {
        await reply(
          chatId,
          "❌ Canal invalide. Envoie un @canal ou une URL t.me, ou clique sur Annuler.",
        );
        return new Response("OK", { status: 200 });
      }

      const { error } = await supabase.from("sources").insert({
        name: `@${channel}`,
        type: "telegram",
        config: { channel },
        is_active: true,
      });
      await clearBotState(supabase, appUser.id);
      if (error)
        await reply(chatId, `❌ Erreur: ${error.message}`, adminMenuMarkup());
      else
        await reply(
          chatId,
          `✅ Source globale ajoutée: <b>@${channel}</b>`,
          adminMenuMarkup(),
        );
      return new Response("OK", { status: 200 });
    }

    if (adminMode && command === "/adminclean") {
      await reply(
        chatId,
        "🧹 <b>Nettoyage admin</b>\n\nChoisis l'action à exécuter. Attention, ces actions sont sensibles.",
        {
          reply_markup: {
            keyboard: [
              ["🗑 DB seulement", "🔥 Tout supprimer"],
              ["❌ Annuler"],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
      return new Response("OK", { status: 200 });
    }

    if (command === "/cancel") {
      await clearBotState(supabase, appUser.id);
      await reply(
        chatId,
        "✅ Action annulée.",
        adminMode ? adminMenuMarkup() : userMenuMarkup(),
      );
      return new Response("OK", { status: 200 });
    }

    if (
      !adminMode &&
      ["/choosepauseflow", "/chooseresumeflow"].includes(command)
    ) {
      const shouldPause = command === "/choosepauseflow";
      const { data: flows, error } = await supabase
        .from("flows")
        .select(
          "id, is_active, source:user_sources(config), target:user_targets(chat_id,title)",
        )
        .eq("user_id", appUser.id)
        .eq("is_active", shouldPause)
        .order("created_at", { ascending: false });

      if (error)
        await reply(chatId, `❌ Erreur: ${error.message}`, userMenuMarkup());
      else if (!flows?.length) {
        await reply(
          chatId,
          shouldPause
            ? "📭 Tu n'as aucun flux actif à désactiver."
            : "📭 Tu n'as aucun flux désactivé à réactiver.",
          userMenuMarkup(),
        );
      } else {
        await setBotState(supabase, appUser.id, {
          step: shouldPause ? "choose_flow_pause" : "choose_flow_resume",
          draft: {},
        });
        await reply(
          chatId,
          shouldPause
            ? "⏸ Choisis le flux à désactiver."
            : "▶️ Choisis le flux à réactiver.",
          flowChoiceMarkup(flows),
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/newflow") {
      await setBotState(supabase, appUser.id, {
        step: "new_flow_source",
        draft: {},
      });
      await reply(
        chatId,
        "➕ <b>Nouveau flux</b>\n\nEnvoie maintenant le canal source à surveiller.\n\nExemple: <code>@canal_source</code> ou <code>https://t.me/canal_source</code>",
        {
          reply_markup: {
            keyboard: [["❌ Annuler"]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        },
      );
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/verifytargetadmin") {
      const state = appUser.bot_state || {};
      const draft = state.draft || {};
      if (
        state.step !== "new_flow_verify_target" ||
        !draft.source_id ||
        !draft.target_id ||
        !draft.target_chat_id
      ) {
        await reply(
          chatId,
          "ℹ️ Aucun canal cible en attente de vérification.",
          userMenuMarkup(),
        );
        return new Response("OK", { status: 200 });
      }

      const check = await checkBotAdminInChat(String(draft.target_chat_id));
      if (!check.ok) {
        await reply(
          chatId,
          `❌ Je ne suis pas encore admin de <b>${draft.target_chat_id}</b>.\n\nDétail: ${check.reason || "vérification impossible"}\n\nAjoute le bot comme admin puis clique encore sur <b>✅ J’ai ajouté le bot</b>.`,
          {
            reply_markup: {
              keyboard: [["✅ J’ai ajouté le bot"], ["❌ Annuler"]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          },
        );
        return new Response("OK", { status: 200 });
      }

      const result = await createFlowForUser(
        supabase,
        appUser,
        String(draft.source_id),
        String(draft.target_id),
      );
      await clearBotState(supabase, appUser.id);
      if (result.error || !result.data) {
        await reply(
          chatId,
          `❌ ${result.error || "Impossible de créer le flux."}`,
          userMenuMarkup(),
        );
      } else {
        await reply(
          chatId,
          `✅ <b>Bot confirmé admin</b>\n\nTon flux est créé avec succès.\nID: <code>${shortId(result.data.id)}</code>\nCible: <b>${draft.target_chat_id}</b>`,
          userMenuMarkup(),
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (
      !adminMode &&
      appUser.bot_state?.step &&
      !buttonCommand &&
      !text.startsWith("/")
    ) {
      const state = appUser.bot_state || {};
      const draft = state.draft || {};

      if (state.step === "deposit_amount") {
        const amount = Number(text.replace(/\s+/g, ""));
        if (!amount || amount < 100) {
          await reply(
            chatId,
            "❌ Montant invalide. Envoie un montant en FCFA supérieur ou égal à 100, ou clique sur Annuler.",
          );
          return new Response("OK", { status: 200 });
        }
        await clearBotState(supabase, appUser.id);
        await reply(chatId, "⏳ Création du lien de dépôt...");
        const result = await createNelsiusCheckout(
          supabase,
          appUser,
          "deposit",
          amount,
        );
        if (result.error || !result.checkoutUrl) {
          await reply(
            chatId,
            `❌ Dépôt indisponible: ${result.error}`,
            userMenuMarkup(),
          );
        } else {
          await reply(
            chatId,
            `💰 <b>Dépôt wallet</b>\n\nMontant: <b>${amount} FCFA</b>\n\nClique sur le bouton ci-dessous pour payer avec Nelsius Pay.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: `💰 Déposer ${amount} FCFA`,
                      url: result.checkoutUrl,
                    },
                  ],
                ],
              },
            },
          );
          await reply(
            chatId,
            "Après paiement, reviens ici et clique sur 🧾 Paiements pour suivre le statut. /me affichera ton solde une fois le paiement confirmé.",
            userMenuMarkup(),
          );
        }
        return new Response("OK", { status: 200 });
      }

      if (["choose_flow_pause", "choose_flow_resume"].includes(state.step)) {
        const idMatch = text.match(/[0-9a-f]{8}/i);
        const flow = idMatch
          ? await findOwnedRecord(supabase, "flows", appUser.id, idMatch[0])
          : null;
        if (!flow) {
          await reply(
            chatId,
            "❌ Flux non reconnu. Choisis un bouton flux ou clique sur Annuler.",
          );
          return new Response("OK", { status: 200 });
        }
        const active = state.step === "choose_flow_resume";
        const { error } = await supabase
          .from("flows")
          .update({ is_active: active })
          .eq("id", flow.id)
          .eq("user_id", appUser.id);
        await clearBotState(supabase, appUser.id);
        if (error)
          await reply(chatId, `❌ Erreur: ${error.message}`, userMenuMarkup());
        else
          await reply(
            chatId,
            active
              ? `▶️ Flux réactivé: <code>${shortId(flow.id)}</code>`
              : `⏸ Flux désactivé: <code>${shortId(flow.id)}</code>`,
            userMenuMarkup(),
          );
        return new Response("OK", { status: 200 });
      }

      if (state.step === "new_flow_source") {
        const { data: source, error } = await getOrCreateUserSource(
          supabase,
          appUser.id,
          text,
        );
        if (error || !source) {
          await reply(
            chatId,
            `❌ ${error || "Impossible d'ajouter la source."}\n\nRenvoie un canal source valide ou clique sur Annuler.`,
          );
          return new Response("OK", { status: 200 });
        }

        const { data: targets } = await supabase
          .from("user_targets")
          .select("id, chat_id, title, is_active")
          .eq("user_id", appUser.id)
          .eq("is_active", true)
          .order("created_at", { ascending: false });

        if (!targets?.length) {
          await setBotState(supabase, appUser.id, {
            step: "new_flow_target_input",
            draft: { source_id: source.id },
          });
          await reply(
            chatId,
            `✅ Source enregistrée: <b>@${source.config?.channel}</b>\n\nMaintenant, envoie le canal cible où republier.\n\nExemple: <code>@mon_canal</code> ou <code>-100...</code>\n\n⚠️ Ajoute le bot comme admin du canal cible.`,
            {
              reply_markup: {
                keyboard: [["❌ Annuler"]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            },
          );
        } else {
          await setBotState(supabase, appUser.id, {
            step: "new_flow_choose_target",
            draft: { source_id: source.id },
          });
          await reply(
            chatId,
            `✅ Source enregistrée: <b>@${source.config?.channel}</b>\n\nChoisis maintenant le canal cible dans les boutons ci-dessous ou ajoute une nouvelle cible.`,
            targetChoiceMarkup(targets),
          );
        }
        return new Response("OK", { status: 200 });
      }

      if (state.step === "new_flow_choose_target") {
        if (text === "➕ Ajouter une cible") {
          await setBotState(supabase, appUser.id, {
            step: "new_flow_target_input",
            draft,
          });
          await reply(
            chatId,
            "🎯 Envoie le canal cible à ajouter.\n\nExemple: <code>@mon_canal</code> ou <code>-100...</code>",
            {
              reply_markup: {
                keyboard: [["❌ Annuler"]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            },
          );
          return new Response("OK", { status: 200 });
        }

        const idMatch = text.match(/[0-9a-f]{8}/i);
        const target = idMatch
          ? await findOwnedRecord(
              supabase,
              "user_targets",
              appUser.id,
              idMatch[0],
            )
          : null;
        if (!target || !target.is_active) {
          await reply(
            chatId,
            "❌ Cible non reconnue. Choisis un bouton cible ou clique sur Annuler.",
          );
          return new Response("OK", { status: 200 });
        }

        await setBotState(supabase, appUser.id, {
          step: "new_flow_verify_target",
          draft: {
            source_id: draft.source_id,
            target_id: target.id,
            target_chat_id: target.chat_id,
          },
        });
        await promptBotAdminSetup(chatId, target.chat_id);
        return new Response("OK", { status: 200 });
      }

      if (state.step === "new_flow_target_input") {
        const { data: target, error } = await getOrCreateUserTarget(
          supabase,
          appUser.id,
          text,
        );
        if (error || !target) {
          await reply(
            chatId,
            `❌ ${error || "Impossible d'ajouter la cible."}\n\nRenvoie un canal cible valide ou clique sur Annuler.`,
          );
          return new Response("OK", { status: 200 });
        }

        await setBotState(supabase, appUser.id, {
          step: "new_flow_verify_target",
          draft: {
            source_id: draft.source_id,
            target_id: target.id,
            target_chat_id: target.chat_id,
          },
        });
        await promptBotAdminSetup(chatId, target.chat_id);
        return new Response("OK", { status: 200 });
      }
    }

    // ── User commands (non-admin allowed) ─────────────────────────────────
    if (
      !adminMode &&
      (command === "/start" || command === "/help" || !command)
    ) {
      const premium = isPremium(appUser);
      const proPlus = isProPlus(appUser);
      const planLabel = proPlus
        ? "🚀 Pro Plus"
        : premium
          ? "💳 Premium"
          : "🆓 Gratuit";
      await reply(
        chatId,
        `👋 <b>Bienvenue sur ton assistant Telegram Auto</b>\n\n` +
          `Ton plan actuel : <b>${planLabel}</b>\n\n` +
          `🆓 <b>Gratuit</b>\n` +
          `• Récupération illimitée\n` +
          `• 1 flux actif : 1 source → 1 canal cible\n` +
          `• Signature IzyNews ajoutée en bas des publications\n\n` +
          `💳 <b>Premium — 500 FCFA/mois</b>\n` +
          `• Plusieurs flux actifs\n` +
          `• Pas de signature automatique\n\n` +
          `🚀 <b>Pro Plus — 1000 FCFA/mois</b>\n` +
          `• Tout Premium\n` +
          `• Traduction automatique\n` +
          `• Filtres avancés par flux\n` +
          `• Remplacement mots/liens et suppression pubs\n\n` +
          `👉 Clique sur <b>➕ Nouveau flux</b> pour commencer.`,
        userMenuMarkup(),
      );
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/me") {
      const premium = isPremium(appUser);
      const proPlus = isProPlus(appUser);
      const planLabel = proPlus ? "Pro Plus" : premium ? "Premium" : "Gratuit";
      const today = new Date().toISOString().slice(0, 10);
      const { data: usage } = await supabase
        .from("usage_daily")
        .select("analyzed_count")
        .eq("user_id", appUser.id)
        .eq("day", today)
        .maybeSingle();
      const used = usage?.analyzed_count ?? 0;
      const limit = "∞";
      await reply(
        chatId,
        `👤 <b>Mon compte</b>\n\n` +
          `Plan: <b>${planLabel}</b>\n` +
          `Messages analysés aujourd'hui: <b>${used}/${limit}</b>\n` +
          `Solde wallet: <b>${appUser.wallet_balance || 0} XAF</b>\n\n` +
          `${premium && appUser.plan_expires_at ? `Expire: <b>${String(appUser.plan_expires_at).slice(0, 10)}</b>\n\n` : ""}` +
          `Pour t'abonner: <code>/subscribe</code>\nPour déposer: <code>/deposit montant</code>\nPaiements: <code>/payments</code>`,
        userMenuMarkup(),
      );
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/subscribe") {
      await reply(
        chatId,
        "⏳ Vérification de ton wallet et préparation Premium...",
      );
      const result = await prepareSubscriptionPayment(
        supabase,
        appUser,
        "premium",
        500,
      );
      if (result.activated) {
        await reply(
          chatId,
          `✅ <b>Premium activé directement avec ton wallet</b>\n\nSolde restant: <b>${result.balanceAfter} XAF</b>`,
          userMenuMarkup(),
        );
      } else if (result.error || !result.checkoutUrl) {
        await reply(
          chatId,
          `❌ Paiement indisponible: ${result.error}`,
          userMenuMarkup(),
        );
      } else {
        await reply(
          chatId,
          `💳 <b>Abonnement Premium</b>\n\nPrix: <b>500 FCFA / mois</b>\nSolde utilisé: <b>${result.walletToDeduct || 0} XAF</b>\nÀ compléter: <b>${result.paymentAmount} XAF</b>\n\nClique sur le bouton ci-dessous pour compléter avec Nelsius Pay.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💳 Payer ${result.paymentAmount} FCFA`,
                    url: result.checkoutUrl,
                  },
                ],
              ],
            },
          },
        );
        await reply(
          chatId,
          "Après paiement, clique sur 🧾 Paiements pour suivre le statut.",
          userMenuMarkup(),
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/proplus") {
      await reply(
        chatId,
        "⏳ Vérification de ton wallet et préparation Pro Plus...",
      );
      const result = await prepareSubscriptionPayment(
        supabase,
        appUser,
        "pro_plus",
        1000,
      );
      if (result.activated) {
        await reply(
          chatId,
          `✅ <b>Pro Plus activé directement avec ton wallet</b>\n\nSolde restant: <b>${result.balanceAfter} XAF</b>`,
          userMenuMarkup(),
        );
      } else if (result.error || !result.checkoutUrl) {
        await reply(
          chatId,
          `❌ Paiement indisponible: ${result.error}`,
          userMenuMarkup(),
        );
      } else {
        await reply(
          chatId,
          `🚀 <b>Abonnement Pro Plus</b>\n\nPrix: <b>1000 FCFA / mois</b>\nSolde utilisé: <b>${result.walletToDeduct || 0} XAF</b>\nÀ compléter: <b>${result.paymentAmount} XAF</b>\n\nInclus: traduction, filtres avancés, remplacement mots/liens et suppression pubs.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `🚀 Payer ${result.paymentAmount} FCFA`,
                    url: result.checkoutUrl,
                  },
                ],
              ],
            },
          },
        );
        await reply(
          chatId,
          "Après paiement, clique sur 🧾 Paiements pour suivre le statut.",
          userMenuMarkup(),
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/profilters") {
      await reply(
        chatId,
        `⚙️ <b>Filtres Pro Plus</b>\n\nCes commandes fonctionnent avec un abonnement Pro Plus actif.\n\nTraduction:\n<code>/translate flow_id fr on</code>\n<code>/translate flow_id en on</code>\n\nRemplacer mots:\n<code>/replace flow_id ancien => nouveau</code>\n\nLiens:\n<code>/links flow_id remove</code>\n<code>/links flow_id replace https://ton-lien.com</code>\n<code>/links flow_id keep</code>\n\nPublicités:\n<code>/blockads flow_id on</code>\n\nMots interdits/obligatoires:\n<code>/include flow_id mot1,mot2</code>\n<code>/exclude flow_id mot1,mot2</code>`,
        userMenuMarkup(),
      );
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/wallet") {
      const { data: txs } = await supabase
        .from("wallet_transactions")
        .select(
          "type, amount, currency, balance_after, description, created_at",
        )
        .eq("user_id", appUser.id)
        .order("created_at", { ascending: false })
        .limit(8);
      const lines = (txs || []).map((t: any) => {
        const sign = Number(t.amount) >= 0 ? "+" : "";
        return `${sign}${t.amount} ${t.currency} — ${t.description || t.type}\nSolde après: <b>${t.balance_after} ${t.currency}</b>`;
      });
      await reply(
        chatId,
        `💼 <b>Mon wallet</b>\n\nSolde actuel: <b>${appUser.wallet_balance || 0} XAF</b>\n\n${lines.length ? lines.join("\n\n") : "Aucune transaction pour le moment."}`,
        userMenuMarkup(),
      );
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/payments") {
      const { data: payments, error } = await supabase
        .from("payments")
        .select(
          "reference, amount, currency, status, payment_type, paid_at, created_at",
        )
        .eq("user_id", appUser.id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (error)
        await reply(chatId, `❌ Erreur: ${error.message}`, userMenuMarkup());
      else if (!payments?.length)
        await reply(
          chatId,
          "📭 Aucun paiement pour le moment.",
          userMenuMarkup(),
        );
      else {
        const statusIcon: Record<string, string> = {
          created: "🕐",
          pending: "⏳",
          paid: "✅",
          success: "✅",
          completed: "✅",
          failed: "❌",
          cancelled: "🚫",
          canceled: "🚫",
        };
        const lines = payments.map((p: any) => {
          const date = new Date(p.created_at).toLocaleString("fr-FR");
          const type = p.payment_type === "deposit" ? "Dépôt" : "Premium";
          const icon = statusIcon[String(p.status || "").toLowerCase()] || "ℹ️";
          return `${icon} <b>${type}</b> — ${p.amount} ${p.currency}\nStatut: <b>${p.status}</b>\nRéf: <code>${p.reference}</code>\n${p.paid_at ? `Payé: ${new Date(p.paid_at).toLocaleString("fr-FR")}` : `Créé: ${date}`}`;
        });
        await reply(
          chatId,
          `🧾 <b>Mes paiements récents</b>\n\n${lines.join("\n\n")}`,
          userMenuMarkup(),
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/deposit") {
      const amount = Number(args[0] || 0);
      if (!amount || amount < 100) {
        await setBotState(supabase, appUser.id, {
          step: "deposit_amount",
          draft: {},
        });
        await reply(
          chatId,
          "💰 <b>Dépôt</b>\n\nEntre le montant à déposer en FCFA.\nMinimum: <b>100 FCFA</b>\n\nExemple: <code>1000</code>",
          {
            reply_markup: {
              keyboard: [["❌ Annuler"]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          },
        );
        return new Response("OK", { status: 200 });
      }

      await reply(chatId, "⏳ Création du lien de dépôt...");
      const result = await createNelsiusCheckout(
        supabase,
        appUser,
        "deposit",
        amount,
      );
      if (result.error || !result.checkoutUrl) {
        await reply(
          chatId,
          `❌ Dépôt indisponible: ${result.error}`,
          userMenuMarkup(),
        );
      } else {
        await reply(
          chatId,
          `💰 <b>Dépôt wallet</b>\n\nMontant: <b>${amount} FCFA</b>\n\nClique sur le bouton ci-dessous pour payer avec Nelsius Pay. Ton solde sera crédité automatiquement après confirmation.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `💰 Déposer ${amount} FCFA`,
                    url: result.checkoutUrl,
                  },
                ],
              ],
            },
          },
        );
        await reply(
          chatId,
          "Après paiement, reviens ici et clique sur 🧾 Paiements pour suivre le statut. /me affichera ton solde une fois le paiement confirmé.",
          userMenuMarkup(),
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/addsource") {
      const channel = normalizeTelegramChannel(args[0] || "");
      if (!channel) {
        await reply(chatId, "⚠️ Usage: /addsource &lt;@canal ou URL t.me&gt;");
      } else {
        const { data: existing } = await supabase
          .from("user_sources")
          .select("id, is_active")
          .eq("user_id", appUser.id)
          .eq("type", "telegram")
          .eq("config->>channel", channel)
          .maybeSingle();

        if (existing) {
          if (!existing.is_active) {
            await supabase
              .from("user_sources")
              .update({ is_active: true })
              .eq("id", existing.id);
          }
          await reply(
            chatId,
            `ℹ️ Source déjà enregistrée: <code>${shortId(existing.id)}</code> — @${channel}`,
          );
        } else {
          const { data: inserted, error } = await supabase
            .from("user_sources")
            .insert({
              user_id: appUser.id,
              type: "telegram",
              config: { channel },
              is_active: true,
            })
            .select("id")
            .maybeSingle();
          if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
          else
            await reply(
              chatId,
              `✅ Source ajoutée\nID: <code>${shortId(inserted.id)}</code>\nCanal: <b>@${channel}</b>`,
            );
        }
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/sources") {
      const { data: sources, error } = await supabase
        .from("user_sources")
        .select("id, type, config, is_active, created_at")
        .eq("user_id", appUser.id)
        .order("created_at", { ascending: false });
      if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
      else if (!sources?.length)
        await reply(
          chatId,
          "📭 Tu n'as aucune source. Ajoute-en une avec /addsource @canal",
        );
      else {
        const lines = sources.map(
          (s: any) =>
            `${s.is_active ? "🟢" : "🔴"} <code>${shortId(s.id)}</code> — @${s.config?.channel || "?"}`,
        );
        await reply(chatId, `📡 <b>Mes sources</b>\n\n${lines.join("\n")}`);
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/delsource") {
      const src = await findOwnedRecord(
        supabase,
        "user_sources",
        appUser.id,
        args[0],
      );
      if (!src) await reply(chatId, "❌ Source non trouvée.");
      else {
        await supabase
          .from("user_sources")
          .update({ is_active: false })
          .eq("id", src.id);
        await supabase
          .from("flows")
          .update({ is_active: false })
          .eq("user_id", appUser.id)
          .eq("source_id", src.id);
        await reply(
          chatId,
          `✅ Source désactivée: <b>@${src.config?.channel || "?"}</b>`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/addtarget") {
      const targetChat = normalizeTargetChat(args[0] || "");
      const title = args.slice(1).join(" ").trim() || targetChat;
      if (!targetChat) {
        await reply(
          chatId,
          "⚠️ Usage: /addtarget &lt;@canal ou -100...&gt; [nom]",
        );
      } else {
        let warning = "";
        try {
          const check = await fetch(`${BASE}/getChat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: targetChat }),
          });
          const checkData = await check.json();
          if (!checkData.ok)
            warning =
              "\n\n⚠️ Je n'arrive pas encore à vérifier ce canal. Ajoute le bot comme admin du canal cible.";
        } catch (_e) {
          warning = "\n\n⚠️ Vérification du canal impossible pour le moment.";
        }

        const { data: existing } = await supabase
          .from("user_targets")
          .select("id, is_active")
          .eq("user_id", appUser.id)
          .eq("chat_id", targetChat)
          .maybeSingle();
        if (existing) {
          if (!existing.is_active) {
            await supabase
              .from("user_targets")
              .update({ is_active: true, title })
              .eq("id", existing.id);
          }
          await reply(
            chatId,
            `ℹ️ Cible déjà enregistrée: <code>${shortId(existing.id)}</code> — ${targetChat}${warning}`,
          );
        } else {
          const { data: inserted, error } = await supabase
            .from("user_targets")
            .insert({
              user_id: appUser.id,
              chat_id: targetChat,
              title,
              is_active: true,
            })
            .select("id")
            .maybeSingle();
          if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
          else
            await reply(
              chatId,
              `✅ Canal cible ajouté\nID: <code>${shortId(inserted.id)}</code>\nCible: <b>${targetChat}</b>${warning}`,
            );
        }
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/targets") {
      const { data: targets, error } = await supabase
        .from("user_targets")
        .select("id, chat_id, title, is_active, created_at")
        .eq("user_id", appUser.id)
        .order("created_at", { ascending: false });
      if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
      else if (!targets?.length)
        await reply(
          chatId,
          "📭 Tu n'as aucun canal cible. Ajoute-en un avec /addtarget @moncanal",
        );
      else {
        const lines = targets.map(
          (t: any) =>
            `${t.is_active ? "🟢" : "🔴"} <code>${shortId(t.id)}</code> — <b>${t.title || t.chat_id}</b> (${t.chat_id})`,
        );
        await reply(
          chatId,
          `🎯 <b>Mes canaux cibles</b>\n\n${lines.join("\n")}`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/deltarget") {
      const target = await findOwnedRecord(
        supabase,
        "user_targets",
        appUser.id,
        args[0],
      );
      if (!target) await reply(chatId, "❌ Canal cible non trouvé.");
      else {
        await supabase
          .from("user_targets")
          .update({ is_active: false })
          .eq("id", target.id);
        await supabase
          .from("flows")
          .update({ is_active: false })
          .eq("user_id", appUser.id)
          .eq("target_id", target.id);
        await reply(
          chatId,
          `✅ Canal cible désactivé: <b>${target.title || target.chat_id}</b>`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/addflow") {
      const premium = isPremium(appUser);
      if (!premium) {
        const { count } = await supabase
          .from("flows")
          .select("*", { count: "exact", head: true })
          .eq("user_id", appUser.id)
          .eq("is_active", true);
        if ((count || 0) >= 1) {
          await reply(
            chatId,
            "🔒 Le plan gratuit autorise 1 seul flux actif. Utilise /subscribe pour passer Premium ou désactive un flux.",
          );
          return new Response("OK", { status: 200 });
        }
      }

      const src = await findOwnedRecord(
        supabase,
        "user_sources",
        appUser.id,
        args[0],
      );
      const target = await findOwnedRecord(
        supabase,
        "user_targets",
        appUser.id,
        args[1],
      );
      if (!src || !src.is_active)
        await reply(
          chatId,
          "❌ Source introuvable ou inactive. Vérifie /sources.",
        );
      else if (!target || !target.is_active)
        await reply(
          chatId,
          "❌ Cible introuvable ou inactive. Vérifie /targets.",
        );
      else {
        const { data: inserted, error } = await supabase
          .from("flows")
          .insert({
            user_id: appUser.id,
            source_id: src.id,
            target_id: target.id,
            mode: "new_only",
            initial_last_n: 5,
            is_active: true,
            filters: DEFAULT_FLOW_FILTERS,
          })
          .select("id")
          .maybeSingle();
        if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
        else
          await reply(
            chatId,
            `✅ Flux créé\nID: <code>${shortId(inserted.id)}</code>\n@${src.config?.channel} → ${target.chat_id}\n\nConfigure les filtres avec /filters ${shortId(inserted.id)}`,
          );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/flows") {
      const { data: flows, error } = await supabase
        .from("flows")
        .select(
          "id, is_active, last_message_id, last_run_at, last_error, filters, source:user_sources(config), target:user_targets(chat_id,title)",
        )
        .eq("user_id", appUser.id)
        .order("created_at", { ascending: false });
      if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
      else if (!flows?.length)
        await reply(
          chatId,
          "📭 Aucun flux. Crée-en un avec /addflow source_id target_id",
        );
      else {
        const lines = flows.map(
          (f: any) =>
            `${f.is_active ? "🟢" : "⏸"} <code>${shortId(f.id)}</code> — @${f.source?.config?.channel || "?"} → ${f.target?.chat_id || "?"}\n   Dernier msg: <b>${f.last_message_id || 0}</b>${f.last_error ? `\n   ⚠️ ${String(f.last_error).substring(0, 80)}` : ""}`,
        );
        await reply(chatId, `🔁 <b>Mes flux</b>\n\n${lines.join("\n\n")}`);
      }
      return new Response("OK", { status: 200 });
    }

    if (
      !adminMode &&
      ["/pauseflow", "/resumeflow", "/deleteflow"].includes(command)
    ) {
      const flow = await findOwnedRecord(
        supabase,
        "flows",
        appUser.id,
        args[0],
      );
      if (!flow) await reply(chatId, "❌ Flux non trouvé.");
      else {
        const active = command === "/resumeflow";
        await supabase
          .from("flows")
          .update({ is_active: active })
          .eq("id", flow.id)
          .eq("user_id", appUser.id);
        await reply(
          chatId,
          command === "/resumeflow"
            ? `▶️ Flux repris: <code>${shortId(flow.id)}</code>`
            : `⏸ Flux désactivé: <code>${shortId(flow.id)}</code>`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/filters") {
      const flow = await findOwnedRecord(
        supabase,
        "flows",
        appUser.id,
        args[0],
      );
      if (!flow) await reply(chatId, "❌ Flux non trouvé.");
      else {
        const filters = mergeFilters(flow.filters, {});
        await reply(
          chatId,
          `🧰 <b>Filtres du flux ${shortId(flow.id)}</b>\n\n` +
            `Mots obligatoires: <b>${filters.include_keywords.length ? filters.include_keywords.join(", ") : "aucun"}</b>\n` +
            `Mots interdits: <b>${filters.exclude_keywords.length ? filters.exclude_keywords.join(", ") : "aucun"}</b>\n` +
            `Bloquer pubs: <b>${filters.block_ads ? "oui" : "non"}</b>\n` +
            `Média seulement: <b>${filters.media_only ? "oui" : "non"}</b>\n` +
            `Albums: <b>${filters.allow_albums ? "oui" : "non"}</b>\n` +
            `Reformulation IA: <b>${filters.use_ai_rewrite ? "oui" : "non"}</b>\n` +
            `Signature: <b>${filters.signature_text || "aucune"}</b>`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (
      !adminMode &&
      [
        "/include",
        "/exclude",
        "/blockads",
        "/mediaonly",
        "/allowalbums",
        "/rewriteai",
        "/signature",
        "/translate",
        "/replace",
        "/links",
      ].includes(command)
    ) {
      if (!isProPlus(appUser)) {
        await reply(
          chatId,
          "🔒 Ces filtres avancés sont réservés au plan Pro Plus. Clique sur 🚀 Pro Plus pour l’activer.",
          userMenuMarkup(),
        );
        return new Response("OK", { status: 200 });
      }

      const flow = await findOwnedRecord(
        supabase,
        "flows",
        appUser.id,
        args[0],
      );
      if (!flow) {
        await reply(chatId, "❌ Flux non trouvé.");
        return new Response("OK", { status: 200 });
      }

      let patch: Record<string, unknown> = {};
      if (command === "/include")
        patch = { include_keywords: parseKeywordList(args.slice(1).join(" ")) };
      if (command === "/exclude")
        patch = { exclude_keywords: parseKeywordList(args.slice(1).join(" ")) };
      if (
        ["/blockads", "/mediaonly", "/allowalbums", "/rewriteai"].includes(
          command,
        )
      ) {
        const value = parseOnOff(args[1]);
        if (value === null) {
          await reply(chatId, `⚠️ Usage: ${command} &lt;flow_id&gt; on|off`);
          return new Response("OK", { status: 200 });
        }
        const key =
          command === "/blockads"
            ? "block_ads"
            : command === "/mediaonly"
              ? "media_only"
              : command === "/allowalbums"
                ? "allow_albums"
                : "use_ai_rewrite";
        patch = { [key]: value };
      }
      if (command === "/signature")
        patch = {
          signature_text: args.slice(1).join(" ").trim().substring(0, 200),
        };
      if (command === "/translate") {
        const lang = (args[1] || "fr").toLowerCase();
        const enabled = parseOnOff(args[2] || "on");
        patch = { target_language: lang, translate_enabled: enabled !== false };
      }
      if (command === "/replace") {
        const raw = args.slice(1).join(" ");
        const [from, to] = raw.split("=>").map((s) => s.trim());
        if (!from || !to) {
          await reply(chatId, "⚠️ Usage: /replace flow_id ancien => nouveau");
          return new Response("OK", { status: 200 });
        }
        const current = mergeFilters(flow.filters, {});
        patch = {
          replacements: { ...(current.replacements || {}), [from]: to },
        };
      }
      if (command === "/links") {
        const action = (args[1] || "keep").toLowerCase();
        if (!["keep", "remove", "replace"].includes(action)) {
          await reply(
            chatId,
            "⚠️ Usage: /links flow_id keep|remove|replace [url]",
          );
          return new Response("OK", { status: 200 });
        }
        patch = {
          link_action: action,
          link_replacement: action === "replace" ? args[2] || "" : "",
        };
      }

      const filters = mergeFilters(flow.filters, patch);
      const { error } = await supabase
        .from("flows")
        .update({ filters })
        .eq("id", flow.id)
        .eq("user_id", appUser.id);
      if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
      else
        await reply(
          chatId,
          `✅ Filtres mis à jour pour le flux <code>${shortId(flow.id)}</code>. Voir /filters ${shortId(flow.id)}`,
        );
      return new Response("OK", { status: 200 });
    }

    if (!adminMode && command === "/activity") {
      const { data: rows, error } = await supabase
        .from("flow_activity")
        .select(
          "id, status, reason, original_url, text_preview, media_count, created_at, flow_id",
        )
        .eq("user_id", appUser.id)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) await reply(chatId, `❌ Erreur: ${error.message}`);
      else if (!rows?.length)
        await reply(chatId, "📭 Aucune activité pour le moment.");
      else {
        const lines = rows.map((r: any) => {
          const date = new Date(r.created_at).toLocaleString("fr-FR");
          return `${r.status === "published" ? "✅" : "⏭"} <code>${shortId(r.flow_id || r.id)}</code> — ${r.status}${r.reason ? ` (${r.reason})` : ""}\n   ${date} — médias: ${r.media_count}\n   ${(r.text_preview || r.original_url || "").substring(0, 90)}`;
        });
        await reply(
          chatId,
          `📊 <b>Dernières activités</b>\n\n${lines.join("\n\n")}`,
        );
      }
      return new Response("OK", { status: 200 });
    }

    // ── Admin-only security gate ──────────────────────────────────────────
    if (!adminMode) {
      await reply(chatId, `❓ Commande inconnue.\n\n${USER_HELP}`);
      return new Response("OK", { status: 200 });
    }

    // ── /start | /help ────────────────────────────────────────────────────
    if (command === "/start" || command === "/help" || !command) {
      await reply(chatId, HELP, adminMenuMarkup());
    }

    // ── /stats ────────────────────────────────────────────────────────────
    else if (command === "/stats") {
      const [{ count: total }, { count: today }] = await Promise.all([
        supabase.from("articles").select("*", { count: "exact", head: true }),
        supabase
          .from("articles")
          .select("*", { count: "exact", head: true })
          .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
      ]);
      const { count: srcCount } = await supabase
        .from("sources")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true);
      await reply(
        chatId,
        `📊 <b>Statistiques</b>\n\n` +
          `📰 Articles total: <b>${total ?? 0}</b>\n` +
          `🕐 Dernières 24h: <b>${today ?? 0}</b>\n` +
          `📡 Sources actives: <b>${srcCount ?? 0}</b>`,
      );
    }

    // ── /list ─────────────────────────────────────────────────────────────
    else if (command === "/list") {
      const limit = Math.min(parseInt(args[0]) || 10, 20);
      const { data: articles, error } = await supabase
        .from("articles")
        .select("id, title, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        await reply(chatId, `❌ Erreur: ${error.message}`);
      } else if (!articles?.length) {
        await reply(chatId, "📭 Aucun article.");
      } else {
        const lines = articles.map((a: any, i: number) => {
          const date = new Date(a.created_at).toLocaleDateString("fr-FR");
          const shortId = a.id.substring(0, 8);
          return `${i + 1}. <code>${shortId}</code> — ${(a.title || "Sans titre").substring(0, 50)}\n   📅 ${date}`;
        });
        await reply(
          chatId,
          `📰 <b>Derniers ${articles.length} articles:</b>\n\n${lines.join("\n\n")}`,
        );
      }
    }

    // ── /article ──────────────────────────────────────────────────────────
    else if (command === "/article") {
      if (!args[0]) {
        await reply(chatId, "⚠️ Usage: /article &lt;id&gt;");
      } else {
        const { data: a } = await supabase
          .from("articles")
          .select("*")
          .ilike("id", `${args[0]}%`)
          .limit(1)
          .maybeSingle();
        if (!a) {
          await reply(chatId, "❌ Article non trouvé.");
        } else {
          const msg =
            `📰 <b>${a.title}</b>\n\n${(a.content || a.summary || "").substring(0, 700)}\n\n` +
            `🔗 <a href="${a.original_url}">Source originale</a>\n` +
            `🆔 <code>${a.id}</code>`;
          if (a.image_url) {
            await sendPhotoToChat(chatId, a.image_url, msg);
          } else {
            await reply(chatId, msg);
          }
        }
      }
    }

    // ── /delete ───────────────────────────────────────────────────────────
    else if (command === "/delete") {
      if (!args[0]) {
        await reply(chatId, "⚠️ Usage: /delete &lt;id&gt;");
      } else {
        const { data: a } = await supabase
          .from("articles")
          .select("id, title")
          .ilike("id", `${args[0]}%`)
          .limit(1)
          .maybeSingle();
        if (!a) {
          await reply(chatId, "❌ Article non trouvé.");
        } else {
          const { error } = await supabase
            .from("articles")
            .delete()
            .eq("id", a.id);
          if (error) {
            await reply(chatId, `❌ Erreur: ${error.message}`);
          } else {
            await reply(
              chatId,
              `✅ Article supprimé:\n<i>${a.title}</i>`,
              adminMenuMarkup(),
            );
          }
        }
      }
    }

    // ── /deleteall ────────────────────────────────────────────────────────
    else if (command === "/deleteall") {
      const { error } = await supabase
        .from("articles")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) {
        await reply(
          chatId,
          `❌ Erreur lors de la suppression: ${error.message}`,
        );
      } else {
        await reply(
          chatId,
          `✅ TOUS les articles ont été supprimés de la base de données.`,
          adminMenuMarkup(),
        );
      }
    }

    // ── /clearall ─────────────────────────────────────────────────────────
    else if (command === "/clearall") {
      const forceMode = args[0] === "force";
      await reply(
        chatId,
        forceMode
          ? "⏳ Nettoyage TOTAL (force) en cours... Cela peut prendre 2-3 minutes."
          : "⏳ Suppression en cours des messages du canal et de la base...",
      );

      try {
        let deletedCount = 0;
        let failedCount = 0;

        // 1. FORCE MODE: Try to delete last 100 messages by message_id range
        if (forceMode && OUTPUT_CHAT_ID) {
          await reply(
            chatId,
            "🔥 Mode FORCE: tentative suppression des 100 derniers messages...",
          );

          // Try to get the latest message first to know where to start
          let startMsgId = 1000; // Default high number
          try {
            const latestRes = await fetch(
              `${BASE}/getUpdates?limit=1&offset=-1`,
            );
            const latestData = await latestRes.json();
            if (latestData.ok && latestData.result?.length > 0) {
              const lastUpdate =
                latestData.result[latestData.result.length - 1];
              if (
                lastUpdate.channel_post?.chat?.id?.toString() ===
                OUTPUT_CHAT_ID.replace("@", "")
              ) {
                startMsgId = lastUpdate.channel_post.message_id;
              }
            }
          } catch (e) {
            console.log(
              "[Bot] Could not get latest update, using default range",
            );
          }

          // Delete from startMsgId down to startMsgId-100
          const endMsgId = Math.max(1, startMsgId - 100);
          for (let msgId = startMsgId; msgId >= endMsgId; msgId--) {
            const delRes = await fetch(`${BASE}/deleteMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: OUTPUT_CHAT_ID,
                message_id: msgId,
              }),
            });
            const delData = await delRes.json();
            if (delData.ok) {
              deletedCount++;
            } else if (
              !delData.description?.includes("message to delete not found")
            ) {
              // Only count real errors, not "message not found"
              failedCount++;
            }
            // Small delay to avoid rate limits
            await new Promise((r) => setTimeout(r, 50));
          }
        }

        // 2. Get all articles with telegram_message_id (for tracked messages)
        const { data: articles, error: fetchError } = await supabase
          .from("articles")
          .select("id, telegram_message_id, telegram_chat_id, title")
          .not("telegram_message_id", "is", null)
          .order("created_at", { ascending: false });

        if (fetchError) {
          await reply(
            chatId,
            `❌ Erreur récupération articles: ${fetchError.message}`,
          );
          return new Response("OK", { status: 200 });
        }

        // 3. Delete tracked messages from Telegram channel
        if (articles && articles.length > 0) {
          for (const article of articles) {
            if (article.telegram_message_id && article.telegram_chat_id) {
              const delRes = await fetch(`${BASE}/deleteMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: article.telegram_chat_id,
                  message_id: article.telegram_message_id,
                }),
              });
              const delData = await delRes.json();
              if (delData.ok) {
                deletedCount++;
              } else {
                failedCount++;
                console.warn(
                  `[Bot] Failed to delete message ${article.telegram_message_id}:`,
                  delData.description,
                );
              }
              // Small delay to avoid rate limits
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }

        // 4. Delete all articles from DB
        const { error: deleteError } = await supabase
          .from("articles")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000");

        if (deleteError) {
          await reply(
            chatId,
            `❌ Erreur suppression DB: ${deleteError.message}`,
          );
          return new Response("OK", { status: 200 });
        }

        // 5. Reset last_message_id in all telegram sources (first run mode)
        const { data: sources } = await supabase
          .from("sources")
          .select("id, config")
          .eq("type", "telegram");

        let resetCount = 0;
        if (sources) {
          for (const source of sources) {
            const newConfig = { ...source.config, last_message_id: "0" };
            const { error: updateError } = await supabase
              .from("sources")
              .update({ config: newConfig })
              .eq("id", source.id);
            if (!updateError) resetCount++;
          }
        }

        await reply(
          chatId,
          `✅ <b>Nettoyage complet terminé</b>\n\n` +
            `${forceMode ? "🔥 Mode FORCE utilisé\n" : ""}` +
            `🗑 Messages Telegram supprimés: <b>${deletedCount}</b>\n` +
            `❌ Échecs: <b>${failedCount}</b>\n` +
            `🗑 Articles DB supprimés: <b>${articles?.length || 0}</b>\n` +
            `🔄 Sources reset: <b>${resetCount}</b>\n\n` +
            `💡 Astuce: Utilise <code>/clearall force</code> pour supprimer les 100 derniers messages du canal (même sans tracking).`,
          adminMenuMarkup(),
        );
      } catch (err) {
        console.error("[Bot] /clearall error:", err);
        await reply(
          chatId,
          `💥 Erreur lors du nettoyage: ${(err as Error).message}`,
        );
      }
    }

    // ── /publish ──────────────────────────────────────────────────────────
    else if (command === "/publish") {
      let content = args.join(" ").trim();
      if (!content && !hasMedia) {
        await reply(
          chatId,
          "⚠️ Usage: /publish <texte>\nOu envoie un média avec /publish en légende.",
        );
      } else {
        let finalTitle = "Publication admin";
        let finalContent = content;
        let isAd = false;

        if (content) {
          const geminiKey = Deno.env.get("GEMINI_API_KEY");
          if (geminiKey) {
            await reply(chatId, "⏳ Structuration avec l'IA...");
            const aiRes = await restructureWithAI(content, geminiKey);
            isAd = aiRes.isAd;
            if (aiRes.title) finalTitle = aiRes.title;
            if (aiRes.content) finalContent = aiRes.content;
          }
        }

        if (isAd) {
          await reply(
            chatId,
            "❌ Ce contenu a été détecté comme une publicité/spam et n'a pas été publié.",
          );
          return new Response("OK", { status: 200 });
        }

        const uniqueSuffix = new Date()
          .toISOString()
          .replace(/[-:.TZ]/g, "")
          .slice(0, 14);
        const uniqueTitle = `${finalTitle} #${uniqueSuffix}`;

        // Automatically append @izynews at the very bottom
        const footer = "\n\n@izynews";
        if (finalContent && !finalContent.includes("@izynews")) {
          finalContent = `${finalContent.trim()}${footer}`;
        } else if (!finalContent && hasMedia) {
          finalContent = footer.trim();
        }

        const imageUrl = photo ? photo[photo.length - 1]?.file_id : null;
        let imagePublicUrl: string | null = null;
        if (imageUrl) {
          const fileRes = await fetch(`${BASE}/getFile?file_id=${imageUrl}`);
          const fileData = await fileRes.json();
          if (fileData.ok) {
            imagePublicUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
          }
        }

        // Insert into database
        const { data: inserted, error } = await supabase
          .from("articles")
          .insert({
            title: uniqueTitle,
            summary: finalContent.substring(0, 500),
            content: finalContent,
            original_url: `https://t.me/admin_publish_${Date.now()}`,
            image_url: imagePublicUrl,
            is_certified: true,
          })
          .select("id")
          .maybeSingle();

        if (error) {
          console.error("[Bot] DB Insert Error:", error);
          await reply(chatId, `❌ Erreur DB: ${error.message}`);
        } else {
          await reply(
            chatId,
            `✅ Article publié!\n🆔 <code>${inserted?.id?.substring(0, 8)}</code>`,
          );

          // Also forward to output channel
          if (OUTPUT_CHAT_ID) {
            if (hasMedia) {
              // Use copyMessage with new caption
              await copyMessageToChat(
                OUTPUT_CHAT_ID,
                chatId,
                messageId,
                finalContent,
              );
            } else {
              await fetch(`${BASE}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: OUTPUT_CHAT_ID,
                  text: finalContent.substring(0, 4096),
                  parse_mode: "HTML",
                }),
              });
            }
          }
        }
      }
    }

    // ── /sources ──────────────────────────────────────────────────────────
    else if (command === "/sources") {
      const { data: sources } = await supabase
        .from("sources")
        .select("id, name, type, config, is_active")
        .order("created_at", { ascending: false });
      if (!sources?.length) {
        await reply(chatId, "📭 Aucune source.");
      } else {
        const lines = sources.map((s: any) => {
          const icon = s.is_active ? "🟢" : "🔴";
          const channel = s.config?.channel || "";
          return `${icon} <code>${s.id.substring(0, 8)}</code> — <b>${s.name}</b> [${s.type}${channel ? ": @" + channel : ""}]`;
        });
        await reply(
          chatId,
          `📡 <b>Sources (${sources.length}):</b>\n\n${lines.join("\n")}`,
        );
      }
    }

    // ── /addsource ────────────────────────────────────────────────────────
    else if (command === "/addsource") {
      let channel = args[0]?.trim();
      if (!channel) {
        await reply(chatId, "⚠️ Usage: /addsource <@canal ou URL_TME>");
      } else {
        if (channel.includes("t.me/")) {
          const parts = channel.split("t.me/");
          channel = parts[parts.length - 1].split("/")[0].split("?")[0];
        }
        channel = channel.replace(/^@/, "").toLowerCase();

        const { error } = await supabase.from("sources").insert({
          name: `@${channel}`,
          type: "telegram",
          config: { channel },
          is_active: true,
        });
        if (error) {
          await reply(chatId, `❌ Erreur: ${error.message}`);
        } else {
          await reply(
            chatId,
            `✅ Source ajoutée avec succès!\n📡 Canal: <b>@${channel}</b>\n\nL'agrégation automatique récupérera les prochaines nouvelles.`,
          );
        }
      }
    }

    // ── /delsource ────────────────────────────────────────────────────────
    else if (command === "/delsource") {
      if (!args[0]) {
        await reply(chatId, "⚠️ Usage: /delsource &lt;id&gt;");
      } else {
        const { data: src } = await supabase
          .from("sources")
          .select("id, name")
          .ilike("id", `${args[0]}%`)
          .limit(1)
          .maybeSingle();
        if (!src) {
          await reply(chatId, "❌ Source non trouvée.");
        } else {
          await supabase
            .from("sources")
            .update({ is_active: false })
            .eq("id", src.id);
          await reply(chatId, `✅ Source désactivée: <b>${src.name}</b>`);
        }
      }
    }

    // ── /run ──────────────────────────────────────────────────────────────
    else if (command === "/run") {
      await reply(chatId, "⏳ Agrégation en cours...");
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const res = await fetch(`${supabaseUrl}/functions/v1/aggregate_news`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceKey}` },
      });
      const raw = await res.text();
      let result: any = null;
      try {
        result = raw ? JSON.parse(raw) : null;
      } catch (_e) {
        result = null;
      }

      if (!res.ok) {
        console.error(
          "[Bot] /run aggregate_news HTTP error:",
          res.status,
          raw?.slice(0, 500),
        );
        await reply(
          chatId,
          `❌ Erreur d'agrégation (HTTP ${res.status}). Vérifie les logs Supabase.`,
        );
        return new Response("OK", { status: 200 });
      }

      if (!result) {
        console.error(
          "[Bot] /run aggregate_news invalid JSON:",
          raw?.slice(0, 500),
        );
        await reply(
          chatId,
          `❌ Erreur d'agrégation: réponse invalide (non-JSON). Vérifie les logs Supabase.`,
        );
        return new Response("OK", { status: 200 });
      }

      if (result.success) {
        await reply(
          chatId,
          `✅ Agrégation terminée!\n📊 Traités: <b>${result.processed}</b>\n🆕 Nouveaux: <b>${result.new}</b>`,
        );
      } else {
        await reply(
          chatId,
          `❌ Erreur d'agrégation: ${result.error || "inconnue"}`,
        );
      }
    }

    // ── Unknown command ───────────────────────────────────────────────────
    else {
      await reply(
        chatId,
        `❓ Commande inconnue. Tape /help pour voir les commandes disponibles.`,
      );
    }
  } catch (err) {
    console.error("[Bot] Error:", err);
    await reply(chatId, `💥 Erreur serveur: ${(err as Error).message}`);
  }

  return new Response("OK", { status: 200 });
});
