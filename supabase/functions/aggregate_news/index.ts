import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const OUTPUT_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const FREE_USER_SIGNATURE =
  Deno.env.get("FREE_USER_SIGNATURE") || "🤖 Propulsé par IzyNews";

// Storj S3-compatible configuration
const STORJ_ACCESS_KEY = Deno.env.get("STORJ_ACCESS_KEY") || "";
const STORJ_SECRET_KEY = Deno.env.get("STORJ_SECRET_KEY") || "";
const STORJ_ENDPOINT =
  Deno.env.get("STORJ_ENDPOINT") || "https://gateway.storjshare.io";
const STORJ_BUCKET = Deno.env.get("STORJ_BUCKET") || "";
const STORJ_REGION = "us-east-1"; // Storj uses this region by default

function isStorjConfigured(): boolean {
  return Boolean(
    STORJ_ACCESS_KEY && STORJ_SECRET_KEY && STORJ_BUCKET && STORJ_ENDPOINT,
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? utf8Bytes(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return new Uint8Array(digest);
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    toArrayBuffer(utf8Bytes(data)),
  );
  return new Uint8Array(sig);
}

function amzDate(now = new Date()): { amz: string; short: string } {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const HH = String(now.getUTCHours()).padStart(2, "0");
  const MM = String(now.getUTCMinutes()).padStart(2, "0");
  const SS = String(now.getUTCSeconds()).padStart(2, "0");
  const short = `${yyyy}${mm}${dd}`;
  const amz = `${short}T${HH}${MM}${SS}Z`;
  return { amz, short };
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUriPathStyle(bucket: string, key: string): string {
  const parts = [`/${bucket}`].concat(key.split("/").map(encodeRfc3986));
  return parts.join("/").replace(/\/+/g, "/");
}

async function getSigningKey(
  secretKey: string,
  dateShort: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(utf8Bytes(`AWS4${secretKey}`), dateShort);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

function buildCanonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join("&");
}

interface ScrapedMessage {
  id: number;
  text: string;
  photoUrls?: string[]; // All photos in album
  videoUrl?: string; // Video if present
  videoDuration?: number; // Duration in seconds (if available)
  hasMedia: boolean;
}

// ── Quick keyword-based ad pre-filter ──────────────────────────────────────
const AD_PATTERNS = [
  /rejoignez.{0,30}(groupe|chaîne|canal)/i,
  /cliquez?\s+ici/i,
  /lien\s+(en\s+bio|affilié)/i,
  /promo|soldes|réduction|rabais/i,
  /invest|trading|crypto|bitcoin|forex/i,
  /gagn\w+\s+de\s+l.argent/i,
  /sponsor|partenariat\s+commercial/i,
  /annonce|à\s+vendre|en\s+vente|prix\s*[:\-]|[📞📱]\s*contact|whatsap/i,
  /cherche\s+.*\s+(emploi|travail|job)|offre\s+d'?emploi/i,
  /recrute|recrutement|urgent|limité|disponible\s+maintenant/i,
  /offre\s+spéciale|exceptionnel|dernière\s+chance|promotion/i,
  /faire\s+de\s+l'argent|gagner\s+(de\s+l')?argent|revenu\s+passif/i,
  /inscription\s+gratuite|inscrivez[-\s]vous/i,
  /💰|💵|💲|🏷️|🛒|🛍️|📢/,
];
const AD_KEYWORDS_STRICT = [
  "annonce",
  "à vendre",
  "en vente",
  "prix:",
  "prix :",
  "contactez",
  "recrutement",
  "offre d'emploi",
  " Opportunité",
  "gagner de l'argent",
];
function isQuickAd(text: string): boolean {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const p of AD_PATTERNS) if (p.test(lower)) hits++;

  // Strict keyword check (immediate detection)
  for (const keyword of AD_KEYWORDS_STRICT) {
    if (lower.includes(keyword.toLowerCase())) {
      console.log(`[Filter] Strict keyword detected: "${keyword}"`);
      return true;
    }
  }

  // Check for excessive caps (typical of ads)
  const capsRatio = (text.match(/[A-Z]/g) || []).length / text.length;
  if (capsRatio > 0.6 && text.length > 15) hits += 2;

  // Check for excessive emoji (ads often have many)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 6) hits++;
  if (emojiCount > 10) hits += 2;

  // Check for excessive numbers (prices, phone numbers)
  const digitCount = (text.match(/\d/g) || []).length;
  if (digitCount > 15) hits++;

  return hits >= 2;
}

// ── Scrape t.me/s/<channel> ──────────────────────────────────────────────
function extractPhotoUrlFromBlock(block: string): string | undefined {
  const bg = block.match(/background-image:url\('([^']+)'\)/);
  if (bg?.[1]) return bg[1];
  const img = block.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
  if (img?.[1]) return img[1];
  const videoPoster = block.match(/<video[^>]+poster="([^"]+)"[^>]*>/i);
  if (videoPoster?.[1]) return videoPoster[1];
  return undefined;
}

// Extract ALL photos from an album message - STRICT filtering
function extractAllPhotosFromBlock(block: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  // Find the main media container for this message
  const mediaContainer = block.match(
    /class="tgme_widget_message_photo_wrap[^"]*"[^>]*>/g,
  );
  if (!mediaContainer) return [];

  // Look for grouped media (album indicator)
  const isAlbum =
    block.includes("tgme_widget_message_grouped_wrap") ||
    block.includes("tgme_widget_message_album");

  // Extract photos from grouped containers (albums)
  if (isAlbum) {
    // Find all photo containers in grouped layout
    const photoBlocks = block.matchAll(
      /class="tgme_widget_message_photo_wrap[^"]*"[^>]*>/g,
    );
    for (const photoBlock of photoBlocks) {
      const bgMatch = photoBlock[0].match(/background-image:url\('([^']+)'\)/);
      if (bgMatch?.[1] && !seen.has(bgMatch[1])) {
        urls.push(bgMatch[1]);
        seen.add(bgMatch[1]);
      }
    }
  }

  // Single photo or backup extraction
  if (urls.length === 0) {
    // Extract from the main widget_photo div only (not nested)
    const photoSection = block.match(
      /<a[^>]*class="tgme_widget_message_photo_wrap[^"]*"[^>]*background-image:url\('([^']+)'\)/,
    );
    if (photoSection?.[1] && !seen.has(photoSection[1])) {
      urls.push(photoSection[1]);
      seen.add(photoSection[1]);
    }

    // Fallback: find background in style attribute (first one only)
    if (urls.length === 0) {
      const bgMatch = block.match(
        /background-image:url\('([^']+\/(?:photos|video_thumbnails)\/[^']+)'\)/,
      );
      if (bgMatch?.[1] && !seen.has(bgMatch[1])) {
        urls.push(bgMatch[1]);
        seen.add(bgMatch[1]);
      }
    }
  }

  // Clean URLs - remove size constraints for full quality
  return urls.map((url) =>
    url.replace(/\?size=[^&]*/, "").replace(/&size=[^&]*/, ""),
  );
}

// Extract video info from block - STRICT filtering
function extractVideoFromBlock(block: string): {
  url?: string;
  duration?: number;
} {
  // Look for video element with src - must be inside tgme_widget_message_video
  const videoSection = block.match(
    /class="tgme_widget_message_video[^"]*"[^>]*>.*?<video[^>]+src="([^"]+)"[^>]*>/is,
  );
  if (!videoSection?.[1]) return {};

  const url = videoSection[1];

  // Try to extract duration from data-duration or time element
  const durationMatch =
    block.match(/data-duration="(\d+)"/) ||
    block.match(/<time[^>]*>(\d+):(\d+)<\/time>/);
  let duration: number | undefined;
  if (durationMatch) {
    if (durationMatch[2]) {
      // MM:SS format
      duration = parseInt(durationMatch[1]) * 60 + parseInt(durationMatch[2]);
    } else {
      duration = parseInt(durationMatch[1]);
    }
  }

  return { url, duration };
}

async function fetchChannelPage(
  channel: string,
  beforeId?: number,
): Promise<string> {
  const url = beforeId
    ? `https://t.me/s/${channel}?before=${beforeId}`
    : `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
  });
  if (!res.ok) {
    console.error(
      `[Scrape] HTTP ${res.status} for ${channel}${beforeId ? ` before=${beforeId}` : ""}`,
    );
    return "";
  }
  return await res.text();
}

async function scrapeChannel(
  channel: string,
  afterId = 0,
): Promise<ScrapedMessage[]> {
  try {
    const messages: ScrapedMessage[] = [];
    const seenIds = new Set<number>();

    let beforeId: number | undefined = undefined;
    let reachedAfter = false;

    for (let page = 0; page < 20; page++) {
      const html = await fetchChannelPage(channel, beforeId);
      if (!html) break;

      const blocks = html.split('<div class="tgme_widget_message_wrap');
      let minIdOnPage: number | undefined;
      let foundAny = false;

      for (const block of blocks.slice(1)) {
        const idMatch = block.match(/data-post="[^"]*\/(\d+)"/);
        if (!idMatch) continue;
        const msgId = parseInt(idMatch[1]);
        if (!Number.isFinite(msgId)) continue;
        foundAny = true;

        if (minIdOnPage === undefined || msgId < minIdOnPage)
          minIdOnPage = msgId;
        if (msgId <= afterId) {
          reachedAfter = true;
          continue;
        }
        if (seenIds.has(msgId)) continue;
        seenIds.add(msgId);

        let text = "";
        const textMatch = block.match(
          /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/,
        );
        if (textMatch) {
          text = textMatch[1]
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&nbsp;/g, " ")
            .trim();
        }

        // Extract all media from the message
        const allPhotos = extractAllPhotosFromBlock(block);
        const videoInfo = extractVideoFromBlock(block);

        const hasMedia = allPhotos.length > 0 || videoInfo.url !== undefined;

        messages.push({
          id: msgId,
          text,
          photoUrls: allPhotos.length > 0 ? allPhotos : undefined,
          videoUrl: videoInfo.url,
          videoDuration: videoInfo.duration,
          hasMedia,
        });
      }

      if (!foundAny) break;
      if (reachedAfter) break;
      if (minIdOnPage === undefined) break;

      beforeId = minIdOnPage;
    }

    return messages.sort((a, b) => a.id - b.id);
  } catch (e) {
    console.error(`[Scrape] Exception for ${channel}:`, e);
    return [];
  }
}

// ── Gemini AI restructuring ──────────────────────────────────────────────
async function restructureWithAI(
  rawText: string,
): Promise<{ title: string; content: string; isAd: boolean }> {
  if (!GEMINI_API_KEY || rawText.length < 10)
    return { title: "", content: rawText, isAd: false };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Tu es un journaliste professionnel pour le canal Telegram @izynews.\nVoici une information brute :\n\n${rawText}\n\nRègles STRICTES :\n1. Si c'est une publicité, spam, crypto promo, recrutement MLM ou contenu commercial : "is_ad": true OBLIGATOIRE.\n2. Sinon reformule de façon claire, percutante, professionnelle avec émojis.\n3. Titre court et accrocheur (max 100 chars) avec émojis.\n4. Mets le titre en <b>gras HTML</b> au début du contenu.\n5. NE mets PAS "@izynews" à la fin.\n\nJSON STRICT uniquement :\n{"is_ad":false,"title":"Titre 🔥","content":"<b>Titre 🔥</b>\\n\\nContenu..."}`,
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
      const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (m) jsonStr = m[1].trim();
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

async function translateWithAI(
  rawText: string,
  targetLanguage: string,
): Promise<string> {
  if (!GEMINI_API_KEY || rawText.length < 3) return rawText;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Traduis le message suivant en ${targetLanguage}. Conserve le sens, les noms propres, les emojis pertinents et les liens si présents. Réponds uniquement avec le texte traduit.\n\n${rawText}`,
                },
              ],
            },
          ],
        }),
      },
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || rawText;
  } catch (e) {
    console.error("[Gemini] Translation error:", e);
    return rawText;
  }
}

// ── Upload to Storj (S3 REST + SigV4) + presigned GET URL for Telegram ──
async function uploadToStorjAndGetSignedUrl(
  buffer: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string | null> {
  if (!isStorjConfigured()) {
    console.warn(
      "[Storj] Not configured (missing env vars), skipping Storj upload",
    );
    return null;
  }

  const endpoint = new URL(STORJ_ENDPOINT);
  const host = endpoint.host;
  const service = "s3";

  const key = `${Date.now()}_${Math.random().toString(36).slice(2)}_${filename}`;
  const canonicalUri = canonicalUriPathStyle(STORJ_BUCKET, key);

  try {
    const { amz, short } = amzDate();
    const payloadHash = toHex(await sha256(buffer));

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amz}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

    const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${short}/${STORJ_REGION}/${service}/aws4_request`;
    const stringToSign = `${algorithm}\n${amz}\n${credentialScope}\n${toHex(await sha256(canonicalRequest))}`;

    const signingKey = await getSigningKey(
      STORJ_SECRET_KEY,
      short,
      STORJ_REGION,
      service,
    );
    const signature = toHex(await hmacSha256(signingKey, stringToSign));
    const authorization = `${algorithm} Credential=${STORJ_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const putUrl = `${endpoint.origin}${canonicalUri}`;
    const putRes = await fetch(putUrl, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "x-amz-date": amz,
        "x-amz-content-sha256": payloadHash,
        authorization: authorization,
      },
      body: buffer as any,
    });

    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => "");
      console.error(
        "[Storj] PUT failed:",
        putRes.status,
        errText?.slice(0, 300),
      );
      return null;
    }

    // Presigned GET for 1 hour so Telegram can download the object.
    const expires = 60 * 60;
    const getParams: Record<string, string> = {
      "X-Amz-Algorithm": algorithm,
      "X-Amz-Credential": `${STORJ_ACCESS_KEY}/${credentialScope}`,
      "X-Amz-Date": amz,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": "host",
    };
    const canonicalQuery = buildCanonicalQuery(getParams);
    const getCanonicalRequest = `GET\n${canonicalUri}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const getStringToSign = `${algorithm}\n${amz}\n${credentialScope}\n${toHex(await sha256(getCanonicalRequest))}`;
    const getSignature = toHex(await hmacSha256(signingKey, getStringToSign));

    const signedGetUrl = `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${getSignature}`;
    console.log(
      `[Storj] Uploaded: ${key} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
    );
    return signedGetUrl;
  } catch (e) {
    console.error("[Storj] Upload/sign error:", e);
    return null;
  }
}

// ── Download media from URL ──────────────────────────────────────────────
async function downloadMedia(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok) {
      console.error(`[Download] HTTP ${res.status} for ${url}`);
      return null;
    }
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (e) {
    console.error("[Download] Error:", e);
    return null;
  }
}

// ── Helper: Build multipart form data ────────────────────────────────────
function buildMultipartForm(
  fields: {
    name: string;
    value: string | Uint8Array;
    filename?: string;
    contentType?: string;
  }[],
  boundary: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const field of fields) {
    parts.push(encoder.encode(`--${boundary}\r\n`));

    if (field.filename) {
      parts.push(
        encoder.encode(
          `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`,
        ),
      );
      parts.push(
        encoder.encode(
          `Content-Type: ${field.contentType || "application/octet-stream"}\r\n\r\n`,
        ),
      );
      parts.push(field.value as Uint8Array);
    } else {
      parts.push(
        encoder.encode(
          `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`,
        ),
      );
      parts.push(encoder.encode(field.value as string));
    }
    parts.push(encoder.encode(`\r\n`));
  }

  parts.push(encoder.encode(`--${boundary}--\r\n`));

  let totalLength = 0;
  for (const part of parts) totalLength += part.length;
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

// ── Send text-only ────────────────────────────────────────────────────────
async function sendTextToTelegram(
  text: string,
  chatId = OUTPUT_CHAT_ID,
): Promise<number | null> {
  if (!chatId || !BOT_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.substring(0, 4096),
          parse_mode: "HTML",
        }),
      },
    );
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }
    console.error("[Telegram] sendMessage failed:", data.description);
  } catch (e) {
    console.error("[Telegram] sendText error:", e);
  }
  return null;
}

// ── Send single photo ────────────────────────────────────────────────────
async function sendPhotoToTelegram(
  text: string,
  photoUrl: string,
  chatId = OUTPUT_CHAT_ID,
): Promise<number | null> {
  if (!chatId || !BOT_TOKEN) return null;
  try {
    console.log(
      `[Telegram] Downloading photo: ${photoUrl.substring(0, 50)}...`,
    );
    const mediaData = await downloadMedia(photoUrl);

    if (!mediaData) {
      console.warn("[Telegram] Failed to download photo, falling back to text");
      return sendTextToTelegram(text, chatId);
    }

    // Upload to Storj (S3) and get a signed GET URL for Telegram
    const storjUrl = await uploadToStorjAndGetSignedUrl(
      mediaData,
      "photo.jpg",
      "image/jpeg",
    );

    if (!storjUrl) {
      console.warn("[Telegram] Failed to upload to Storj, using direct upload");
      // Fallback: direct upload to Telegram
      return await uploadPhotoDirect(text, mediaData, chatId);
    }

    // Send using Storj URL (permanent)
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: storjUrl,
          caption: text.substring(0, 1024),
          parse_mode: "HTML",
        }),
      },
    );

    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      console.log(
        `[Telegram] Photo sent via Storj, msg_id: ${data.result.message_id}`,
      );
      return data.result.message_id;
    }
    console.warn(
      "[Telegram] sendPhoto with Storj URL failed:",
      data.description,
    );
    return sendTextToTelegram(text, chatId);
  } catch (e) {
    console.error("[Telegram] sendPhoto error:", e);
    return sendTextToTelegram(text, chatId);
  }
}

// ── Upload photo directly to Telegram (fallback) ───────────────────────
async function uploadPhotoDirect(
  text: string,
  mediaData: Uint8Array,
  chatId = OUTPUT_CHAT_ID,
): Promise<number | null> {
  const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
  const body = buildMultipartForm(
    [
      { name: "chat_id", value: chatId },
      { name: "caption", value: text.substring(0, 1024) },
      { name: "parse_mode", value: "HTML" },
      {
        name: "photo",
        value: mediaData,
        filename: "image.jpg",
        contentType: "image/jpeg",
      },
    ],
    boundary,
  );

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body as any,
    },
  );

  const data = await res.json();
  if (data.ok && data.result?.message_id) {
    console.log(
      `[Telegram] Photo sent directly, msg_id: ${data.result.message_id}`,
    );
    return data.result.message_id;
  }
  return null;
}

// ── Send album (multiple photos) ───────────────────────────────────────────
async function sendAlbumToTelegram(
  text: string,
  photoUrls: string[],
  chatId = OUTPUT_CHAT_ID,
): Promise<number | null> {
  if (!chatId || !BOT_TOKEN) return null;
  try {
    console.log(
      `[Telegram] Processing album with ${photoUrls.length} photos...`,
    );

    // Download all photos
    const mediaItems: { url: string; data: Uint8Array | null }[] = [];
    for (const url of photoUrls) {
      const data = await downloadMedia(url);
      mediaItems.push({ url, data });
      await new Promise((r) => setTimeout(r, 100)); // Rate limit protection
    }

    const validPhotos = mediaItems.filter((item) => item.data !== null);
    console.log(
      `[Telegram] Downloaded ${validPhotos.length}/${photoUrls.length} photos`,
    );

    if (validPhotos.length === 0) {
      return sendTextToTelegram(text, chatId);
    }

    if (validPhotos.length === 1) {
      // Single photo fallback
      return sendPhotoToTelegram(text, validPhotos[0].url, chatId);
    }

    // Build media group - caption only on first item
    const boundary =
      "----FormBoundary" + Math.random().toString(36).substring(2);
    const fields: {
      name: string;
      value: string | Uint8Array;
      filename?: string;
      contentType?: string;
    }[] = [{ name: "chat_id", value: chatId }];

    // Build media array JSON
    const mediaArray = validPhotos.map((photo, index) => ({
      type: "photo",
      media: `attach://photo${index}`,
      caption: index === 0 ? text.substring(0, 1024) : undefined,
      parse_mode: index === 0 ? "HTML" : undefined,
    }));
    fields.push({ name: "media", value: JSON.stringify(mediaArray) });

    // Add photo files
    validPhotos.forEach((photo, index) => {
      fields.push({
        name: `photo${index}`,
        value: photo.data!,
        filename: `photo${index}.jpg`,
        contentType: "image/jpeg",
      });
    });

    const body = buildMultipartForm(fields, boundary);

    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: body as any,
      },
    );

    const data = await res.json();
    if (data.ok && data.result?.length > 0) {
      console.log(
        `[Telegram] Album sent (${validPhotos.length} photos), first msg_id: ${data.result[0].message_id}`,
      );
      return data.result[0].message_id;
    }
    console.warn("[Telegram] sendMediaGroup failed:", data.description);

    // Fallback: send first photo with caption
    return sendPhotoToTelegram(text, validPhotos[0].url, chatId);
  } catch (e) {
    console.error("[Telegram] sendAlbum error:", e);
    return sendTextToTelegram(text, chatId);
  }
}

// ── Send video ───────────────────────────────────────────────────────────
async function sendVideoToTelegram(
  text: string,
  videoUrl: string,
  chatId = OUTPUT_CHAT_ID,
): Promise<number | null> {
  if (!chatId || !BOT_TOKEN) return null;
  try {
    console.log(
      `[Telegram] Downloading video: ${videoUrl.substring(0, 50)}...`,
    );
    const mediaData = await downloadMedia(videoUrl);

    if (!mediaData) {
      console.warn("[Telegram] Failed to download video, falling back to text");
      return sendTextToTelegram(text, chatId);
    }

    console.log(
      `[Telegram] Video downloaded: ${(mediaData.length / 1024 / 1024).toFixed(2)} MB`,
    );

    // Upload to Storj (S3) and get a signed GET URL for Telegram
    const storjUrl = await uploadToStorjAndGetSignedUrl(
      mediaData,
      "video.mp4",
      "video/mp4",
    );

    if (!storjUrl) {
      console.warn("[Telegram] Failed to upload to Storj, using direct upload");
      // Fallback: direct upload to Telegram
      return await uploadVideoDirect(text, mediaData, chatId);
    }

    // Send using Storj URL (permanent)
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          video: storjUrl,
          caption: text.substring(0, 1024),
          parse_mode: "HTML",
          supports_streaming: true,
        }),
      },
    );

    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      console.log(
        `[Telegram] Video sent via Storj, msg_id: ${data.result.message_id}`,
      );
      return data.result.message_id;
    }
    console.warn(
      "[Telegram] sendVideo with Storj URL failed:",
      data.description,
    );
    return sendTextToTelegram(text, chatId);
  } catch (e) {
    console.error("[Telegram] sendVideo error:", e);
    return sendTextToTelegram(text, chatId);
  }
}

// ── Upload video directly to Telegram (fallback) ───────────────────────
async function uploadVideoDirect(
  text: string,
  mediaData: Uint8Array,
  chatId = OUTPUT_CHAT_ID,
): Promise<number | null> {
  const boundary = "----FormBoundary" + Math.random().toString(36).substring(2);
  const body = buildMultipartForm(
    [
      { name: "chat_id", value: chatId },
      { name: "caption", value: text.substring(0, 1024) },
      { name: "parse_mode", value: "HTML" },
      { name: "supports_streaming", value: "true" },
      {
        name: "video",
        value: mediaData,
        filename: "video.mp4",
        contentType: "video/mp4",
      },
    ],
    boundary,
  );

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: body as any,
    },
  );

  const data = await res.json();
  if (data.ok && data.result?.message_id) {
    console.log(
      `[Telegram] Video sent directly, msg_id: ${data.result.message_id}`,
    );
    return data.result.message_id;
  }
  return null;
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

function isPlanActive(user: any, planNames: string[]): boolean {
  if (!user || !planNames.includes(user.plan)) return false;
  if (!user.plan_expires_at) return true;
  return new Date(user.plan_expires_at).getTime() > Date.now();
}

function isPremiumUser(user: any): boolean {
  return isPlanActive(user, ["premium", "pro_plus"]);
}

function isProPlusUser(user: any): boolean {
  return isPlanActive(user, ["pro_plus"]);
}

function normalizeFilters(filters: any) {
  return { ...DEFAULT_FLOW_FILTERS, ...(filters || {}) };
}

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) =>
    lower.includes(String(keyword).toLowerCase()),
  );
}

function skipReasonForFilters(
  msg: ScrapedMessage,
  filters: any,
): string | null {
  const include = Array.isArray(filters.include_keywords)
    ? filters.include_keywords
    : [];
  const exclude = Array.isArray(filters.exclude_keywords)
    ? filters.exclude_keywords
    : [];
  const hasPhotos = Boolean(msg.photoUrls?.length);
  const isAlbum = Boolean(msg.photoUrls && msg.photoUrls.length > 1);
  const hasVideo = Boolean(msg.videoUrl);
  const hasText = msg.text.trim().length > 0;

  if (filters.media_only && !msg.hasMedia) return "media_only";
  if (!filters.allow_text && hasText && !msg.hasMedia)
    return "text_not_allowed";
  if (!filters.allow_photos && hasPhotos) return "photos_not_allowed";
  if (!filters.allow_videos && hasVideo) return "videos_not_allowed";
  if (!filters.allow_albums && isAlbum) return "albums_not_allowed";
  if (include.length > 0 && !hasAnyKeyword(msg.text, include))
    return "missing_include_keyword";
  if (exclude.length > 0 && hasAnyKeyword(msg.text, exclude))
    return "excluded_keyword";
  if (filters.block_ads && isQuickAd(msg.text)) return "ad_blocked";
  return null;
}

function transformContent(
  text: string,
  filters: any,
  proPlus: boolean,
  paidUser: boolean,
): string {
  let out = text.trim();

  if (proPlus) {
    const replacements = filters.replacements || {};
    for (const [from, to] of Object.entries(replacements)) {
      if (!from) continue;
      out = out.replace(
        new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        String(to),
      );
    }

    if (filters.link_action === "remove" || filters.remove_links) {
      out = out.replace(/https?:\/\/\S+/gi, "").trim();
    } else if (filters.link_action === "replace" && filters.link_replacement) {
      out = out
        .replace(/https?:\/\/\S+/gi, String(filters.link_replacement))
        .trim();
    }

    if (filters.remove_mentions) out = out.replace(/@\w+/g, "").trim();
    if (filters.signature_text)
      out = `${out}\n\n${String(filters.signature_text).trim()}`.trim();
  }

  if (!paidUser) out = `${out}\n\n${FREE_USER_SIGNATURE}`.trim();
  return out;
}

async function recordActivity(supabase: any, payload: Record<string, unknown>) {
  const { error } = await supabase.from("flow_activity").insert(payload);
  if (error) console.error("[Aggregate] flow_activity insert error:", error);
}

async function incrementUsage(supabase: any, userId: string, amount: number) {
  const day = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("usage_daily")
    .select("id, analyzed_count")
    .eq("user_id", userId)
    .eq("day", day)
    .maybeSingle();

  if (data) {
    await supabase
      .from("usage_daily")
      .update({ analyzed_count: (data.analyzed_count || 0) + amount })
      .eq("id", data.id);
  } else {
    await supabase
      .from("usage_daily")
      .insert({ user_id: userId, day, analyzed_count: amount });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  try {
    const { data: flows, error: flowError } = await supabase
      .from("flows")
      .select(
        "*, user:app_users(*), source:user_sources(*), target:user_targets(*)",
      )
      .eq("is_active", true)
      .order("created_at", { ascending: true });

    if (flowError) throw flowError;

    if (!flows || flows.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          new: 0,
          message: "No active user flows",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    let processedCount = 0;
    let publishedCount = 0;
    let skippedCount = 0;
    const warnedUserIds = new Set<string>();

    for (const flow of flows) {
      const user = flow.user;
      const source = flow.source;
      const target = flow.target;
      const filters = normalizeFilters(flow.filters);

      if (!user?.is_active || !source?.is_active || !target?.is_active)
        continue;
      if (source.type !== "telegram") continue;

      const premium = isPremiumUser(user);
      const proPlus = isProPlusUser(user);

      if (premium && user.plan_expires_at && !warnedUserIds.has(user.id)) {
        const expiresAt = new Date(user.plan_expires_at).getTime();
        const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
        const lastWarn = user.last_subscription_warning_at
          ? new Date(user.last_subscription_warning_at).getTime()
          : 0;
        if (daysLeft > 0 && daysLeft <= 5 && Date.now() - lastWarn > 86400000) {
          await sendTextToTelegram(
            `⏰ Salut ${user.username ? "@" + user.username : "cher utilisateur"},\n\nTon abonnement <b>${user.plan === "pro_plus" ? "Pro Plus" : "Premium"}</b> expire dans <b>${daysLeft} jour(s)</b>. Pense à renouveler pour garder tes fonctionnalités actives.`,
            String(user.telegram_user_id),
          );
          await supabase
            .from("app_users")
            .update({ last_subscription_warning_at: new Date().toISOString() })
            .eq("id", user.id);
          warnedUserIds.add(user.id);
        }
      }

      const channel = source.config?.channel;
      const targetChatId = target.chat_id;
      const lastMsgId = Number(flow.last_message_id || 0);
      if (!channel || !targetChatId) continue;

      console.log(
        `[Aggregate] Flow ${flow.id}: @${channel} → ${targetChatId}, after ${lastMsgId}`,
      );

      try {
        const messages = await scrapeChannel(channel, lastMsgId);
        let messagesToProcess = messages;
        if (
          lastMsgId === 0 &&
          messages.length > Number(flow.initial_last_n || 5)
        ) {
          messagesToProcess = messages.slice(-Number(flow.initial_last_n || 5));
        }

        let maxMsgId = lastMsgId;
        let analyzedForThisFlow = 0;

        for (const msg of messagesToProcess) {
          processedCount++;
          analyzedForThisFlow++;
          maxMsgId = Math.max(maxMsgId, msg.id);

          if (msg.text.length < 20 && !msg.hasMedia) continue;

          const originalUrl = `https://t.me/${channel}/${msg.id}`;
          const { data: alreadyProcessed } = await supabase
            .from("flow_activity")
            .select("id")
            .eq("flow_id", flow.id)
            .eq("source_message_id", msg.id)
            .eq("status", "published")
            .maybeSingle();

          if (alreadyProcessed) continue;

          const reason = proPlus ? skipReasonForFilters(msg, filters) : null;
          if (reason) {
            skippedCount++;
            await recordActivity(supabase, {
              user_id: user.id,
              flow_id: flow.id,
              source_id: source.id,
              target_id: target.id,
              source_message_id: msg.id,
              status: "skipped",
              reason,
              original_url: originalUrl,
              text_preview: msg.text.substring(0, 200),
              media_count:
                (msg.photoUrls?.length || 0) + (msg.videoUrl ? 1 : 0),
            });
            continue;
          }

          let finalContent = msg.text;
          if (proPlus && filters.use_ai_rewrite && msg.text.length >= 10) {
            const aiRes = await restructureWithAI(msg.text);
            if (aiRes.isAd) {
              skippedCount++;
              await recordActivity(supabase, {
                user_id: user.id,
                flow_id: flow.id,
                source_id: source.id,
                target_id: target.id,
                source_message_id: msg.id,
                status: "skipped",
                reason: "ai_ad_blocked",
                original_url: originalUrl,
                text_preview: msg.text.substring(0, 200),
                media_count:
                  (msg.photoUrls?.length || 0) + (msg.videoUrl ? 1 : 0),
              });
              continue;
            }
            finalContent = aiRes.content.trim();
          }

          if (proPlus && filters.translate_enabled) {
            finalContent = await translateWithAI(
              finalContent,
              filters.target_language || "fr",
            );
          }

          const textToPublish =
            transformContent(finalContent, filters, proPlus, premium) ||
            originalUrl;
          const isShortVideo =
            msg.videoUrl && (!msg.videoDuration || msg.videoDuration <= 60);
          let telegramMsgId: number | null = null;

          if (
            isShortVideo &&
            msg.videoUrl &&
            (proPlus ? filters.allow_videos : true)
          ) {
            telegramMsgId = await sendVideoToTelegram(
              textToPublish,
              msg.videoUrl,
              targetChatId,
            );
          } else if (
            msg.photoUrls &&
            msg.photoUrls.length > 1 &&
            (proPlus ? filters.allow_albums : true)
          ) {
            const albumUrls = msg.photoUrls.slice(0, 10);
            telegramMsgId = await sendAlbumToTelegram(
              textToPublish,
              albumUrls,
              targetChatId,
            );
          } else if (
            msg.photoUrls &&
            msg.photoUrls.length > 0 &&
            (proPlus ? filters.allow_photos : true)
          ) {
            telegramMsgId = await sendPhotoToTelegram(
              textToPublish,
              msg.photoUrls[0],
              targetChatId,
            );
          } else if (proPlus ? filters.allow_text : true) {
            telegramMsgId = await sendTextToTelegram(
              textToPublish,
              targetChatId,
            );
          }

          if (!telegramMsgId) {
            skippedCount++;
            await recordActivity(supabase, {
              user_id: user.id,
              flow_id: flow.id,
              source_id: source.id,
              target_id: target.id,
              source_message_id: msg.id,
              status: "failed",
              reason: "publish_failed",
              original_url: originalUrl,
              text_preview: msg.text.substring(0, 200),
              media_count:
                (msg.photoUrls?.length || 0) + (msg.videoUrl ? 1 : 0),
            });
            continue;
          }

          publishedCount++;
          await recordActivity(supabase, {
            user_id: user.id,
            flow_id: flow.id,
            source_id: source.id,
            target_id: target.id,
            source_message_id: msg.id,
            target_message_ids: [telegramMsgId],
            status: "published",
            original_url: originalUrl,
            text_preview: msg.text.substring(0, 200),
            media_count: (msg.photoUrls?.length || 0) + (msg.videoUrl ? 1 : 0),
            raw_payload: {
              target_chat_id: targetChatId,
              source_channel: channel,
            },
          });

          await new Promise((r) => setTimeout(r, 1500));
        }

        if (analyzedForThisFlow > 0)
          await incrementUsage(supabase, user.id, analyzedForThisFlow);

        await supabase
          .from("flows")
          .update({
            last_message_id: maxMsgId,
            last_run_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", flow.id);
      } catch (flowErr) {
        console.error(`[Aggregate] Flow ${flow.id} failed:`, flowErr);
        await supabase
          .from("flows")
          .update({
            last_run_at: new Date().toISOString(),
            last_error: (flowErr as Error).message,
          })
          .eq("id", flow.id);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        new: publishedCount,
        skipped: skippedCount,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[Aggregate] Fatal error:", err);
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500 },
    );
  }
});
