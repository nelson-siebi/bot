import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const OUTPUT_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

interface ScrapedMessage {
  id: number;
  text: string;
  photoUrl?: string;
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
];
function isQuickAd(text: string): boolean {
  let hits = 0;
  for (const p of AD_PATTERNS) if (p.test(text)) hits++;
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

async function fetchChannelPage(channel: string, beforeId?: number): Promise<string> {
  const url = beforeId ? `https://t.me/s/${channel}?before=${beforeId}` : `https://t.me/s/${channel}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
  });
  if (!res.ok) {
    console.error(`[Scrape] HTTP ${res.status} for ${channel}${beforeId ? ` before=${beforeId}` : ''}`);
    return '';
  }
  return await res.text();
}

async function scrapeChannel(channel: string, afterId = 0): Promise<ScrapedMessage[]> {
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

        if (minIdOnPage === undefined || msgId < minIdOnPage) minIdOnPage = msgId;
        if (msgId <= afterId) {
          reachedAfter = true;
          continue;
        }
        if (seenIds.has(msgId)) continue;
        seenIds.add(msgId);

        let text = '';
        const textMatch = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (textMatch) {
          text = textMatch[1]
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
            .trim();
        }

        const photoUrl = extractPhotoUrlFromBlock(block);
        messages.push({ id: msgId, text, photoUrl });
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
async function restructureWithAI(rawText: string): Promise<{ title: string; content: string; isAd: boolean }> {
  if (!GEMINI_API_KEY || rawText.length < 10) return { title: '', content: rawText, isAd: false };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Tu es un journaliste professionnel pour le canal Telegram @izynews.\nVoici une information brute :\n\n${rawText}\n\nRègles STRICTES :\n1. Si c'est une publicité, spam, crypto promo, recrutement MLM ou contenu commercial : "is_ad": true OBLIGATOIRE.\n2. Sinon reformule de façon claire, percutante, professionnelle avec émojis.\n3. Titre court et accrocheur (max 100 chars) avec émojis.\n4. Mets le titre en <b>gras HTML</b> au début du contenu.\n5. NE mets PAS "@izynews" à la fin.\n\nJSON STRICT uniquement :\n{"is_ad":false,"title":"Titre 🔥","content":"<b>Titre 🔥</b>\\n\\nContenu..."}` }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    const data = await res.json();
    const textResp = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (textResp) {
      let jsonStr = textResp.trim();
      const m = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (m) jsonStr = m[1].trim();
      const parsed = JSON.parse(jsonStr);
      return { title: parsed.title || '', content: parsed.content || rawText, isAd: parsed.is_ad === true };
    }
  } catch (e) {
    console.error('[Gemini] Error:', e);
  }
  return { title: '', content: rawText, isAd: false };
}

// ── Send to output Telegram channel ─────────────────────────────────────
async function sendToTelegram(text: string, photoUrl?: string) {
  if (!OUTPUT_CHAT_ID || !BOT_TOKEN) return;
  try {
    if (photoUrl) {
      // sendPhoto accepts direct URL
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: OUTPUT_CHAT_ID,
          photo: photoUrl,
          caption: text.substring(0, 1024),
          parse_mode: 'HTML',
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        // If photo URL fails, fall back to text-only
        console.warn('[Telegram] sendPhoto failed, falling back to text:', data.description);
        await sendToTelegram(text);
      }
    } else {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: OUTPUT_CHAT_ID, text: text.substring(0, 4096), parse_mode: 'HTML' }),
      });
      if (!res.ok) console.error('[Telegram] sendMessage failed:', await res.text());
    }
  } catch (e) {
    console.error('[Telegram] send error:', e);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  try {
    const { data: sources } = await supabase
      .from('sources')
      .select('*')
      .eq('type', 'telegram')
      .eq('is_active', true);

    if (!sources || sources.length === 0) {
      return new Response(JSON.stringify({ success: true, new: 0, message: 'No active sources' }));
    }

    let processedCount = 0;
    let newArticlesCount = 0;

    for (const source of sources) {
      const channel = source.config?.channel;
      if (!channel) continue;

      // Get last processed message ID for this source (tracked in config)
      const lastMsgId = parseInt(source.config?.last_message_id || '0');

      console.log(`[Aggregate] Scraping @${channel}, after message ID: ${lastMsgId}`);
      const messages = await scrapeChannel(channel, lastMsgId);
      console.log(`[Aggregate] Found ${messages.length} new message(s) in @${channel}`);

      let maxMsgId = lastMsgId;

      for (const msg of messages) {
        processedCount++;
        maxMsgId = Math.max(maxMsgId, msg.id);

        if (msg.text.length < 20 && !msg.photoUrl) continue;

        // ── Deduplication: use original_url (t.me/channel/msgId) as unique key
        const originalUrl = `https://t.me/${channel}/${msg.id}`;
        const { data: existing } = await supabase
          .from('articles')
          .select('id')
          .eq('original_url', originalUrl)
          .maybeSingle();

        if (existing) {
          console.log(`[Aggregate] Already processed: ${originalUrl}`);
          continue;
        }

        // ── Quick ad pre-filter
        if (isQuickAd(msg.text)) {
          console.log(`[Aggregate] Quick ad filter blocked msg ${msg.id}`);
          continue;
        }

        // ── AI restructuring
        let finalContent = msg.text;
        if (msg.text.length >= 10) {
          const aiRes = await restructureWithAI(msg.text);
          if (aiRes.isAd) {
            console.log(`[Aggregate] Gemini detected ad in msg ${msg.id}, skipping`);
            continue;
          }
          finalContent = aiRes.content.trim();
        }

        const textWithCredit = `${finalContent}\n\n📢 @izynews`;

        // ── Save to DB
        const { error: insertError } = await supabase
          .from('articles')
          .insert({
            title: finalContent.replace(/<[^>]+>/g, '').substring(0, 100),
            summary: msg.text.substring(0, 200),
            content: textWithCredit,
            original_url: originalUrl,
            source_id: source.id,
            is_certified: false,
          });

        if (insertError) {
          console.error('[Aggregate] DB insert error:', insertError);
          continue;
        }

        // ── Publish to Telegram channel
        await sendToTelegram(textWithCredit, msg.photoUrl);
        newArticlesCount++;
        console.log(`[Aggregate] Published msg ${msg.id} from @${channel}`);

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 1500));
      }

      // ── Update last_message_id in source config so next run starts from here
      if (maxMsgId > lastMsgId) {
        await supabase
          .from('sources')
          .update({ config: { ...source.config, last_message_id: String(maxMsgId) } })
          .eq('id', source.id);
        console.log(`[Aggregate] Updated last_message_id for @${channel} to ${maxMsgId}`);
      }
    }

    return new Response(
      JSON.stringify({ success: true, processed: processedCount, new: newArticlesCount }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Aggregate] Fatal error:', err);
    return new Response(JSON.stringify({ success: false, error: (err as Error).message }), { status: 500 });
  }
});
