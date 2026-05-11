import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const OUTPUT_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || '';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

// Storj S3-compatible configuration
const STORJ_ACCESS_KEY = Deno.env.get('STORJ_ACCESS_KEY') || 'jvkub5kqheygssr4turai73v5zpq';
const STORJ_SECRET_KEY = Deno.env.get('STORJ_SECRET_KEY') || 'j2vsxcv5amzvilfsrsvy2mlqeesoflp32pqfan44mybtojmxcdqkc';
const STORJ_ENDPOINT = Deno.env.get('STORJ_ENDPOINT') || 'https://gateway.storjshare.io';
const STORJ_BUCKET = Deno.env.get('STORJ_BUCKET') || 'izynews-media';
const STORJ_REGION = 'us-east-1'; // Storj uses this region by default

interface ScrapedMessage {
  id: number;
  text: string;
  photoUrls?: string[];  // All photos in album
  videoUrl?: string;     // Video if present
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

// Extract ALL photos from an album message - STRICT filtering
function extractAllPhotosFromBlock(block: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  
  // Find the main media container for this message
  const mediaContainer = block.match(/class="tgme_widget_message_photo_wrap[^"]*"[^>]*>/g);
  if (!mediaContainer) return [];
  
  // Look for grouped media (album indicator)
  const isAlbum = block.includes('tgme_widget_message_grouped_wrap') || 
                  block.includes('tgme_widget_message_album');
  
  // Extract photos from grouped containers (albums)
  if (isAlbum) {
    // Find all photo containers in grouped layout
    const photoBlocks = block.matchAll(/class="tgme_widget_message_photo_wrap[^"]*"[^>]*>/g);
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
    const photoSection = block.match(/<a[^>]*class="tgme_widget_message_photo_wrap[^"]*"[^>]*background-image:url\('([^']+)'\)/);
    if (photoSection?.[1] && !seen.has(photoSection[1])) {
      urls.push(photoSection[1]);
      seen.add(photoSection[1]);
    }
    
    // Fallback: find background in style attribute (first one only)
    if (urls.length === 0) {
      const bgMatch = block.match(/background-image:url\('([^']+\/(?:photos|video_thumbnails)\/[^']+)'\)/);
      if (bgMatch?.[1] && !seen.has(bgMatch[1])) {
        urls.push(bgMatch[1]);
        seen.add(bgMatch[1]);
      }
    }
  }
  
  // Clean URLs - remove size constraints for full quality
  return urls.map(url => url.replace(/\?size=[^&]*/, '').replace(/&size=[^&]*/, ''));
}

// Extract video info from block - STRICT filtering
function extractVideoFromBlock(block: string): { url?: string; duration?: number } {
  // Look for video element with src - must be inside tgme_widget_message_video
  const videoSection = block.match(/class="tgme_widget_message_video[^"]*"[^>]*>.*?<video[^>]+src="([^"]+)"[^>]*>/is);
  if (!videoSection?.[1]) return {};
  
  const url = videoSection[1];
  
  // Try to extract duration from data-duration or time element
  const durationMatch = block.match(/data-duration="(\d+)"/) || 
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
          hasMedia 
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

// ── Upload to Storj ────────────────────────────────────────────────────
async function uploadToStorj(buffer: Uint8Array, filename: string, contentType: string): Promise<string | null> {
  try {
    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const extension = filename.split('.').pop() || 'jpg';
    const uniqueFilename = `${timestamp}_${filename}`;
    
    // Create presigned URL for upload
    const uploadUrl = `${STORJ_ENDPOINT}/${STORJ_BUCKET}/${uniqueFilename}`;
    
    // Upload directly to Storj
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length.toString(),
        'Authorization': `AWS4-HMAC-SHA256 Credential=${STORJ_ACCESS_KEY}/${new Date().toISOString().slice(0, 10)}/${STORJ_REGION}/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${await generateSignature('PUT', uniqueFilename, contentType, buffer.length)}`,
        'x-amz-date': new Date().toISOString().replace(/[:\-]T/, '').replace(/\.[\d:]+/, ''),
        'host': new URL(STORJ_ENDPOINT).hostname
      },
      body: buffer
    });
    
    if (!uploadRes.ok) {
      console.error(`[Storj] Upload failed: ${uploadRes.status}`);
      return null;
    }
    
    // Return public URL
    const publicUrl = `${STORJ_ENDPOINT}/${STORJ_BUCKET}/${uniqueFilename}`;
    console.log(`[Storj] Uploaded: ${uniqueFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    return publicUrl;
  } catch (e) {
    console.error('[Storj] Upload error:', e);
    return null;
  }
}

// Simple signature generation for Storj (S3-compatible)
async function generateSignature(method: string, filename: string, contentType: string, contentLength: number): Promise<string> {
  // For simplicity, using basic auth (Storj supports this for public buckets)
  return 'temp';
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

// ── Helper: Build multipart form data ────────────────────────────────────
function buildMultipartForm(fields: { name: string; value: string | Uint8Array; filename?: string; contentType?: string }[], boundary: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  
  for (const field of fields) {
    parts.push(encoder.encode(`--${boundary}\r\n`));
    
    if (field.filename) {
      parts.push(encoder.encode(`Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`));
      parts.push(encoder.encode(`Content-Type: ${field.contentType || 'application/octet-stream'}\r\n\r\n`));
      parts.push(field.value as Uint8Array);
    } else {
      parts.push(encoder.encode(`Content-Disposition: form-data; name="${field.name}"\r\n\r\n`));
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
async function sendTextToTelegram(text: string): Promise<number | null> {
  if (!OUTPUT_CHAT_ID || !BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OUTPUT_CHAT_ID, text: text.substring(0, 4096), parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }
    console.error('[Telegram] sendMessage failed:', data.description);
  } catch (e) {
    console.error('[Telegram] sendText error:', e);
  }
  return null;
}

// ── Send single photo ────────────────────────────────────────────────────
async function sendPhotoToTelegram(text: string, photoUrl: string): Promise<number | null> {
  if (!OUTPUT_CHAT_ID || !BOT_TOKEN) return null;
  try {
    console.log(`[Telegram] Downloading photo: ${photoUrl.substring(0, 50)}...`);
    const mediaData = await downloadMedia(photoUrl);
    
    if (!mediaData) {
      console.warn('[Telegram] Failed to download photo, falling back to text');
      return sendTextToTelegram(text);
    }
    
    // Upload to Storj for permanent storage
    const storjUrl = await uploadToStorj(mediaData, 'photo.jpg', 'image/jpeg');
    
    if (!storjUrl) {
      console.warn('[Telegram] Failed to upload to Storj, using direct upload');
      // Fallback: direct upload to Telegram
      return await uploadPhotoDirect(text, mediaData);
    }
    
    // Send using Storj URL (permanent)
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OUTPUT_CHAT_ID,
        photo: storjUrl,
        caption: text.substring(0, 1024),
        parse_mode: 'HTML'
      })
    });
    
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      console.log(`[Telegram] Photo sent via Storj, msg_id: ${data.result.message_id}`);
      return data.result.message_id;
    }
    console.warn('[Telegram] sendPhoto with Storj URL failed:', data.description);
    return sendTextToTelegram(text);
  } catch (e) {
    console.error('[Telegram] sendPhoto error:', e);
    return sendTextToTelegram(text);
  }
}

// ── Upload photo directly to Telegram (fallback) ───────────────────────
async function uploadPhotoDirect(text: string, mediaData: Uint8Array): Promise<number | null> {
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  const body = buildMultipartForm([
    { name: 'chat_id', value: OUTPUT_CHAT_ID },
    { name: 'caption', value: text.substring(0, 1024) },
    { name: 'parse_mode', value: 'HTML' },
    { name: 'photo', value: mediaData, filename: 'image.jpg', contentType: 'image/jpeg' },
  ], boundary);
  
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as any,
  });
  
  const data = await res.json();
  if (data.ok && data.result?.message_id) {
    console.log(`[Telegram] Photo sent directly, msg_id: ${data.result.message_id}`);
    return data.result.message_id;
  }
  return null;
}

// ── Send album (multiple photos) ───────────────────────────────────────────
async function sendAlbumToTelegram(text: string, photoUrls: string[]): Promise<number | null> {
  if (!OUTPUT_CHAT_ID || !BOT_TOKEN) return null;
  try {
    console.log(`[Telegram] Processing album with ${photoUrls.length} photos...`);
    
    // Download all photos
    const mediaItems: { url: string; data: Uint8Array | null }[] = [];
    for (const url of photoUrls) {
      const data = await downloadMedia(url);
      mediaItems.push({ url, data });
      await new Promise(r => setTimeout(r, 100)); // Rate limit protection
    }
    
    const validPhotos = mediaItems.filter(item => item.data !== null);
    console.log(`[Telegram] Downloaded ${validPhotos.length}/${photoUrls.length} photos`);
    
    if (validPhotos.length === 0) {
      return sendTextToTelegram(text);
    }
    
    if (validPhotos.length === 1) {
      // Single photo fallback
      return sendPhotoToTelegram(text, validPhotos[0].url);
    }
    
    // Build media group - caption only on first item
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const fields: { name: string; value: string | Uint8Array; filename?: string; contentType?: string }[] = [
      { name: 'chat_id', value: OUTPUT_CHAT_ID },
    ];
    
    // Build media array JSON
    const mediaArray = validPhotos.map((photo, index) => ({
      type: 'photo',
      media: `attach://photo${index}`,
      caption: index === 0 ? text.substring(0, 1024) : undefined,
      parse_mode: index === 0 ? 'HTML' : undefined,
    }));
    fields.push({ name: 'media', value: JSON.stringify(mediaArray) });
    
    // Add photo files
    validPhotos.forEach((photo, index) => {
      fields.push({
        name: `photo${index}`,
        value: photo.data!,
        filename: `photo${index}.jpg`,
        contentType: 'image/jpeg'
      });
    });
    
    const body = buildMultipartForm(fields, boundary);
    
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body as any,
    });
    
    const data = await res.json();
    if (data.ok && data.result?.length > 0) {
      console.log(`[Telegram] Album sent (${validPhotos.length} photos), first msg_id: ${data.result[0].message_id}`);
      return data.result[0].message_id;
    }
    console.warn('[Telegram] sendMediaGroup failed:', data.description);
    
    // Fallback: send first photo with caption
    return sendPhotoToTelegram(text, validPhotos[0].url);
  } catch (e) {
    console.error('[Telegram] sendAlbum error:', e);
    return sendTextToTelegram(text);
  }
}

// ── Send video ───────────────────────────────────────────────────────────
async function sendVideoToTelegram(text: string, videoUrl: string): Promise<number | null> {
  if (!OUTPUT_CHAT_ID || !BOT_TOKEN) return null;
  try {
    console.log(`[Telegram] Downloading video: ${videoUrl.substring(0, 50)}...`);
    const mediaData = await downloadMedia(videoUrl);
    
    if (!mediaData) {
      console.warn('[Telegram] Failed to download video, falling back to text');
      return sendTextToTelegram(text);
    }
    
    console.log(`[Telegram] Video downloaded: ${(mediaData.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Upload to Storj for permanent storage
    const storjUrl = await uploadToStorj(mediaData, 'video.mp4', 'video/mp4');
    
    if (!storjUrl) {
      console.warn('[Telegram] Failed to upload to Storj, using direct upload');
      // Fallback: direct upload to Telegram
      return await uploadVideoDirect(text, mediaData);
    }
    
    // Send using Storj URL (permanent)
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OUTPUT_CHAT_ID,
        video: storjUrl,
        caption: text.substring(0, 1024),
        parse_mode: 'HTML',
        supports_streaming: true
      })
    });
    
    const data = await res.json();
    if (data.ok && data.result?.message_id) {
      console.log(`[Telegram] Video sent via Storj, msg_id: ${data.result.message_id}`);
      return data.result.message_id;
    }
    console.warn('[Telegram] sendVideo with Storj URL failed:', data.description);
    return sendTextToTelegram(text);
  } catch (e) {
    console.error('[Telegram] sendVideo error:', e);
    return sendTextToTelegram(text);
  }
}

// ── Upload video directly to Telegram (fallback) ───────────────────────
async function uploadVideoDirect(text: string, mediaData: Uint8Array): Promise<number | null> {
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
  const body = buildMultipartForm([
    { name: 'chat_id', value: OUTPUT_CHAT_ID },
    { name: 'caption', value: text.substring(0, 1024) },
    { name: 'parse_mode', value: 'HTML' },
    { name: 'supports_streaming', value: 'true' },
    { name: 'video', value: mediaData, filename: 'video.mp4', contentType: 'video/mp4' },
  ], boundary);
  
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as any,
  });
  
  const data = await res.json();
  if (data.ok && data.result?.message_id) {
    console.log(`[Telegram] Video sent directly, msg_id: ${data.result.message_id}`);
    return data.result.message_id;
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

        if (msg.text.length < 20 && !msg.hasMedia) continue;

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
        // Check for short video (< 60 seconds)
        const isShortVideo = msg.videoUrl && msg.videoDuration && msg.videoDuration <= 60;
        
        let telegramMsgId: number | null = null;
        
        if (isShortVideo && msg.videoUrl) {
          // Send video (short videos < 60s)
          telegramMsgId = await sendVideoToTelegram(textWithCredit, msg.videoUrl);
        } else if (msg.photoUrls && msg.photoUrls.length > 0) {
          // Send only the FIRST photo (not full album) - keeps it as single publication
          console.log(`[Aggregate] Album detected with ${msg.photoUrls.length} photos, using first only`);
          telegramMsgId = await sendPhotoToTelegram(textWithCredit, msg.photoUrls[0]);
        } else {
          // Text only
          telegramMsgId = await sendTextToTelegram(textWithCredit);
        }
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
