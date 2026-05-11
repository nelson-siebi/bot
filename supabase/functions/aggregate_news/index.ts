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
  /annonce|à\s+vendre|en\s+vente|prix\s*[:\-]|[📞📱]\s*contact|whatsap/i,
  /cherche\s+.*\s+(emploi|travail|job)|offre\s+d'?emploi/i,
  /recrute|recrutement|urgent|limité|disponible\s+maintenant/i,
  /offre\s+spéciale|exceptionnel|dernière\s+chance|promotion/i,
  /faire\s+de\s+l'argent|gagner\s+(de\s+l')?argent|revenu\s+passif/i,
  /inscription\s+gratuite|inscrivez[-\s]vous/i,
  /💰|💵|💲|🏷️|🛒|🛍️|📢/,
];
const AD_KEYWORDS_STRICT = [
  'annonce', 'à vendre', 'en vente', 'prix:', 'prix :', 'contactez', 
  'recrutement', 'offre d\'emploi', ' Opportunité', 'gagner de l\'argent'
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

// ── Download media from URL ──────────────────────────────────────────────
async function downloadMedia(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) {
      console.error(`[Download] HTTP ${res.status} for ${url}`);
      return null;
    }
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (e) {
    console.error('[Download] Error:', e);
    return null;
  }
}

// ── Send to output Telegram channel ─────────────────────────────────────
// Returns the telegram message_id if successful
async function sendToTelegram(text: string, photoUrl?: string): Promise<number | null> {
  if (!OUTPUT_CHAT_ID || !BOT_TOKEN) return null;
  try {
    // If we have a photo URL, download and re-upload it
    if (photoUrl) {
      console.log(`[Telegram] Downloading media from: ${photoUrl.substring(0, 50)}...`);
      const mediaData = await downloadMedia(photoUrl);
      
      if (mediaData) {
        // Build multipart form data for upload
        const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
        const encoder = new TextEncoder();
        
        // Build form data parts
        const parts: Uint8Array[] = [];
        
        // Add chat_id
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="chat_id"\r\n\r\n`));
        parts.push(encoder.encode(`${OUTPUT_CHAT_ID}\r\n`));
        
        // Add caption
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="caption"\r\n\r\n`));
        parts.push(encoder.encode(`${text.substring(0, 1024)}\r\n`));
        
        // Add parse_mode
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="parse_mode"\r\n\r\n`));
        parts.push(encoder.encode(`HTML\r\n`));
        
        // Add photo file
        const filename = 'image.jpg';
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n`));
        parts.push(encoder.encode(`Content-Type: image/jpeg\r\n\r\n`));
        parts.push(mediaData);
        parts.push(encoder.encode(`\r\n`));
        
        // End boundary
        parts.push(encoder.encode(`--${boundary}--\r\n`));
        
        // Combine all parts
        let totalLength = 0;
        for (const part of parts) totalLength += part.length;
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          body.set(part, offset);
          offset += part.length;
        }
        
        // Send with multipart/form-data
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST',
          headers: { 
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });
        
        const data = await res.json();
        if (data.ok && data.result?.message_id) {
          console.log(`[Telegram] Photo uploaded successfully, msg_id: ${data.result.message_id}`);
          return data.result.message_id;
        }
        console.warn('[Telegram] Upload failed:', data.description);
      } else {
        console.warn('[Telegram] Failed to download media, falling back to text');
      }
      
      // If photo upload failed, fall back to text-only
      console.log('[Telegram] Falling back to text-only message');
    }
    
    // Text-only send
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OUTPUT_CHAT_ID, text: text.substring(0, 4096), parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }
    if (!data.ok) {
      console.error('[Telegram] sendMessage failed:', data.description);
    }
  } catch (e) {
    console.error('[Telegram] send error:', e);
  }
  return null;
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

      // FIRST RUN: limit to last 5 messages only to avoid spam
      let messagesToProcess = messages;
      if (lastMsgId === 0 && messages.length > 5) {
        messagesToProcess = messages.slice(-5); // Take only last 5
        console.log(`[Aggregate] First run - limiting to last 5 messages only`);
      }

      let maxMsgId = lastMsgId;

      for (const msg of messagesToProcess) {
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

        // ── Quick ad pre-filter (STRICT MODE)
        if (isQuickAd(msg.text)) {
          console.log(`[Aggregate] 🚫 AD BLOCKED: msg ${msg.id} from @${channel}`);
          // Mark as processed to avoid re-processing
          maxMsgId = Math.max(maxMsgId, msg.id);
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

        // ── Publish to Telegram channel FIRST (to get message_id)
        const telegramMsgId = await sendToTelegram(textWithCredit, msg.photoUrl);
        if (!telegramMsgId) {
          console.warn(`[Aggregate] Failed to publish msg ${msg.id} to Telegram, skipping DB insert`);
          continue;
        }

        // ── Save to DB with telegram_message_id
        const { error: insertError } = await supabase
          .from('articles')
          .insert({
            title: finalContent.replace(/<[^>]+>/g, '').substring(0, 100),
            summary: msg.text.substring(0, 200),
            content: textWithCredit,
            original_url: originalUrl,
            source_id: source.id,
            is_certified: false,
            telegram_message_id: telegramMsgId,
            telegram_chat_id: OUTPUT_CHAT_ID,
          });

        if (insertError) {
          console.error('[Aggregate] DB insert error:', insertError);
          // Try to delete the telegram message if DB insert failed
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: OUTPUT_CHAT_ID, message_id: telegramMsgId }),
            });
          } catch (e) {
            console.error('[Aggregate] Failed to cleanup telegram message:', e);
          }
          continue;
        }

        newArticlesCount++;
        console.log(`[Aggregate] Published msg ${msg.id} from @${channel} (TG msg_id: ${telegramMsgId})`);

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
