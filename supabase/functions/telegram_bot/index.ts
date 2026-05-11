import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const OUTPUT_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || '';
const BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Admin IDs: comma-separated Telegram user/chat IDs allowed to control the bot
const ADMIN_IDS = (Deno.env.get('TELEGRAM_ADMIN_IDS') || OUTPUT_CHAT_ID)
  .split(',').map(id => id.trim()).filter(Boolean);

function isAdmin(id: number | string): boolean {
  return ADMIN_IDS.includes(String(id));
}

async function reply(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.substring(0, 4096), parse_mode: 'HTML', ...extra }),
    });
    if (!res.ok) console.error('[Bot] sendMessage failed:', await res.text());
  } catch (e) {
    console.error('[Bot] sendMessage exception:', e);
  }
}

async function sendPhotoToChat(chatId: number | string, photoFileId: string, caption: string) {
  try {
    const res = await fetch(`${BASE}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoFileId, caption: caption.substring(0, 1024), parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('[Bot] sendPhoto failed:', await res.text());
  } catch (e) {
    console.error('[Bot] sendPhoto exception:', e);
  }
}

async function copyMessageToChat(chatId: number | string, fromChatId: number | string, messageId: number, caption?: string) {
  const body: any = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  };
  if (caption !== undefined) {
    body.caption = caption.substring(0, 1024);
    body.parse_mode = 'HTML';
  }
  try {
    const res = await fetch(`${BASE}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) console.error('[Bot] copyMessage failed:', data);
    return data;
  } catch (e) {
    console.error('[Bot] copyMessage exception:', e);
    return { ok: false, error: e };
  }
}

async function restructureWithAI(rawText: string, apiKey: string): Promise<{ title: string, content: string, isAd: boolean }> {
  if (!apiKey || !rawText || rawText.length < 5) return { title: '', content: rawText, isAd: false };
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Tu es un journaliste professionnel et éditeur de nouvelles pour le canal Telegram @izynews.\nVoici une information brute issue d'un canal source :\n\n${rawText}\n\nInstructions :\n1. Analyse très attentivement le texte. S'il s'agit d'une publicité, d'un contenu sponsorisé, d'un appel commercial, de crypto-monnaie promotionnelle ou de spam, mets IMPÉRATIVEMENT "is_ad": true dans le JSON.\n2. Si ce n'est pas une pub, reformule l'information pour qu'elle soit claire, percutante, professionnelle, et attrayante.\n3. Écris un titre court et captivant (max 100 caractères), TOUJOURS bien stylisé et agrémenté de PLUSIEURS émojis (stickers) variés en rapport direct avec la situation pour attirer l'oeil.\n4. Intègre ce titre tout en haut du contenu reformulé, en le mettant en gras avec des balises HTML (<b>Titre</b>).\n5. Ajoute des émojis pertinents tout au long du texte pour aérer la lecture.\n6. Conserve les détails importants (dates, lieux, personnes).\n7. Ne mets PAS "@izynews" à la fin, je le ferai programmatiquement.\n\nRéponds UNIQUEMENT au format JSON strict suivant :\n{\n  "is_ad": false,\n  "title": "Titre stylisé avec emojis 🚀",\n  "content": "<b>Titre stylisé avec emojis 🚀</b>\\n\\nContenu reformulé ici avec des émojis... ✅"\n}`
          }]
        }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
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
        title: parsed.title || '', 
        content: parsed.content || rawText,
        isAd: parsed.is_ad === true
      };
    }
  } catch(e) {
    console.error('[Gemini] Error:', e);
  }
  return { title: '', content: rawText, isAd: false };
}

// ── HELP TEXT ─────────────────────────────────────────────────────────────────
const HELP = `🤖 <b>Bot Admin — Gestion des infos</b>\n\n<b>📰 Articles</b>\n/list [n] — Derniers articles (défaut: 10, max: 20)\n/article &lt;id&gt; — Voir un article\n/delete &lt;id&gt; — Supprimer un article\n/deleteall — Supprimer TOUS les articles (DB seulement)\n/clearall — Supprimer TOUT (canal Telegram + DB + reset sources)\n/clearall force — Supprimer les 100 derniers messages du canal (nucléaire)\n/publish &lt;texte&gt; — Publier un article (texte)\n  ↳ Envoie une photo avec /publish en légende pour publier avec image\n\n<b>📡 Sources Telegram</b>\n/sources — Liste des sources actives\n/addsource &lt;@canal ou URL&gt; — Ajouter un canal Telegram\n/delsource &lt;id&gt; — Désactiver une source\n\n<b>⚙️ Système</b>\n/run — Lancer l'agrégation maintenant\n/stats — Statistiques de la plateforme\n/help — Afficher ce message`;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Telegram Bot Webhook — OK', { status: 200 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response('Bad Request', { status: 400 }); }

  const message = (body.message || body.edited_message) as Record<string, unknown> | undefined;
  if (!message) return new Response('OK', { status: 200 });

  const chatId = (message.chat as any)?.id as number;
  const userId = (message.from as any)?.id as number;
  const messageId = message.message_id as number;
  const text = ((message.text || message.caption || '') as string).trim();
  const photo = (message.photo as any[]) || null;
  const hasMedia = !!(photo || message.video || message.document || message.audio || message.animation || message.voice);

  // ── Security ──────────────────────────────────────────────────────────────
  if (!isAdmin(chatId) && !isAdmin(userId)) {
    await reply(chatId, '⛔ Accès refusé.');
    return new Response('OK', { status: 200 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const parts = text.split(/\s+/);
  const command = parts[0]?.toLowerCase() || '';
  const args = parts.slice(1);

  try {
    // ── /start | /help ────────────────────────────────────────────────────
    if (command === '/start' || command === '/help' || !command) {
      await reply(chatId, HELP);
    }

    // ── /stats ────────────────────────────────────────────────────────────
    else if (command === '/stats') {
      const [{ count: total }, { count: today }] = await Promise.all([
        supabase.from('articles').select('*', { count: 'exact', head: true }),
        supabase.from('articles').select('*', { count: 'exact', head: true })
          .gte('created_at', new Date(Date.now() - 86400000).toISOString()),
      ]);
      const { count: srcCount } = await supabase.from('sources')
        .select('*', { count: 'exact', head: true }).eq('is_active', true);
      await reply(chatId,
        `📊 <b>Statistiques</b>\n\n` +
        `📰 Articles total: <b>${total ?? 0}</b>\n` +
        `🕐 Dernières 24h: <b>${today ?? 0}</b>\n` +
        `📡 Sources actives: <b>${srcCount ?? 0}</b>`
      );
    }

    // ── /list ─────────────────────────────────────────────────────────────
    else if (command === '/list') {
      const limit = Math.min(parseInt(args[0]) || 10, 20);
      const { data: articles, error } = await supabase
        .from('articles').select('id, title, created_at')
        .order('created_at', { ascending: false }).limit(limit);

      if (error) { await reply(chatId, `❌ Erreur: ${error.message}`); }
      else if (!articles?.length) { await reply(chatId, '📭 Aucun article.'); }
      else {
        const lines = articles.map((a, i) => {
          const date = new Date(a.created_at).toLocaleDateString('fr-FR');
          const shortId = a.id.substring(0, 8);
          return `${i + 1}. <code>${shortId}</code> — ${(a.title || 'Sans titre').substring(0, 50)}\n   📅 ${date}`;
        });
        await reply(chatId, `📰 <b>Derniers ${articles.length} articles:</b>\n\n${lines.join('\n\n')}`);
      }
    }

    // ── /article ──────────────────────────────────────────────────────────
    else if (command === '/article') {
      if (!args[0]) { await reply(chatId, '⚠️ Usage: /article &lt;id&gt;'); }
      else {
        const { data: a } = await supabase.from('articles').select('*')
          .ilike('id', `${args[0]}%`).limit(1).maybeSingle();
        if (!a) { await reply(chatId, '❌ Article non trouvé.'); }
        else {
          const msg = `📰 <b>${a.title}</b>\n\n${(a.content || a.summary || '').substring(0, 700)}\n\n` +
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
    else if (command === '/delete') {
      if (!args[0]) { await reply(chatId, '⚠️ Usage: /delete &lt;id&gt;'); }
      else {
        const { data: a } = await supabase.from('articles').select('id, title')
          .ilike('id', `${args[0]}%`).limit(1).maybeSingle();
        if (!a) { await reply(chatId, '❌ Article non trouvé.'); }
        else {
          const { error } = await supabase.from('articles').delete().eq('id', a.id);
          if (error) { await reply(chatId, `❌ Erreur: ${error.message}`); }
          else { await reply(chatId, `✅ Article supprimé:\n<i>${a.title}</i>`); }
        }
      }
    }

    // ── /deleteall ────────────────────────────────────────────────────────
    else if (command === '/deleteall') {
      const { error } = await supabase.from('articles').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) { await reply(chatId, `❌ Erreur lors de la suppression: ${error.message}`); }
      else { await reply(chatId, `✅ TOUS les articles ont été supprimés de la base de données.`); }
    }

    // ── /clearall ─────────────────────────────────────────────────────────
    else if (command === '/clearall') {
      const forceMode = args[0] === 'force';
      await reply(chatId, forceMode 
        ? '⏳ Nettoyage TOTAL (force) en cours... Cela peut prendre 2-3 minutes.' 
        : '⏳ Suppression en cours des messages du canal et de la base...'
      );
      
      try {
        let deletedCount = 0;
        let failedCount = 0;

        // 1. FORCE MODE: Try to delete last 100 messages by message_id range
        if (forceMode && OUTPUT_CHAT_ID) {
          await reply(chatId, '🔥 Mode FORCE: tentative suppression des 100 derniers messages...');
          
          // Try to get the latest message first to know where to start
          let startMsgId = 1000; // Default high number
          try {
            const latestRes = await fetch(`${BASE}/getUpdates?limit=1&offset=-1`);
            const latestData = await latestRes.json();
            if (latestData.ok && latestData.result?.length > 0) {
              const lastUpdate = latestData.result[latestData.result.length - 1];
              if (lastUpdate.channel_post?.chat?.id?.toString() === OUTPUT_CHAT_ID.replace('@', '')) {
                startMsgId = lastUpdate.channel_post.message_id;
              }
            }
          } catch (e) {
            console.log('[Bot] Could not get latest update, using default range');
          }

          // Delete from startMsgId down to startMsgId-100
          const endMsgId = Math.max(1, startMsgId - 100);
          for (let msgId = startMsgId; msgId >= endMsgId; msgId--) {
            const delRes = await fetch(`${BASE}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: OUTPUT_CHAT_ID,
                message_id: msgId,
              }),
            });
            const delData = await delRes.json();
            if (delData.ok) {
              deletedCount++;
            } else if (!delData.description?.includes('message to delete not found')) {
              // Only count real errors, not "message not found"
              failedCount++;
            }
            // Small delay to avoid rate limits
            await new Promise(r => setTimeout(r, 50));
          }
        }

        // 2. Get all articles with telegram_message_id (for tracked messages)
        const { data: articles, error: fetchError } = await supabase
          .from('articles')
          .select('id, telegram_message_id, telegram_chat_id, title')
          .not('telegram_message_id', 'is', null)
          .order('created_at', { ascending: false });
        
        if (fetchError) {
          await reply(chatId, `❌ Erreur récupération articles: ${fetchError.message}`);
          return new Response('OK', { status: 200 });
        }

        // 3. Delete tracked messages from Telegram channel
        if (articles && articles.length > 0) {
          for (const article of articles) {
            if (article.telegram_message_id && article.telegram_chat_id) {
              const delRes = await fetch(`${BASE}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
                console.warn(`[Bot] Failed to delete message ${article.telegram_message_id}:`, delData.description);
              }
              // Small delay to avoid rate limits
              await new Promise(r => setTimeout(r, 100));
            }
          }
        }

        // 4. Delete all articles from DB
        const { error: deleteError } = await supabase
          .from('articles')
          .delete()
          .neq('id', '00000000-0000-0000-0000-000000000000');
        
        if (deleteError) {
          await reply(chatId, `❌ Erreur suppression DB: ${deleteError.message}`);
          return new Response('OK', { status: 200 });
        }

        // 5. Reset last_message_id in all telegram sources (first run mode)
        const { data: sources } = await supabase
          .from('sources')
          .select('id, config')
          .eq('type', 'telegram');
        
        let resetCount = 0;
        if (sources) {
          for (const source of sources) {
            const newConfig = { ...source.config, last_message_id: '0' };
            const { error: updateError } = await supabase
              .from('sources')
              .update({ config: newConfig })
              .eq('id', source.id);
            if (!updateError) resetCount++;
          }
        }

        await reply(chatId, 
          `✅ <b>Nettoyage complet terminé</b>\n\n` +
          `${forceMode ? '🔥 Mode FORCE utilisé\n' : ''}` +
          `🗑 Messages Telegram supprimés: <b>${deletedCount}</b>\n` +
          `❌ Échecs: <b>${failedCount}</b>\n` +
          `🗑 Articles DB supprimés: <b>${articles?.length || 0}</b>\n` +
          `🔄 Sources reset: <b>${resetCount}</b>\n\n` +
          `💡 Astuce: Utilise <code>/clearall force</code> pour supprimer les 100 derniers messages du canal (même sans tracking).`
        );
      } catch (err) {
        console.error('[Bot] /clearall error:', err);
        await reply(chatId, `💥 Erreur lors du nettoyage: ${(err as Error).message}`);
      }
    }

    // ── /publish ──────────────────────────────────────────────────────────
    else if (command === '/publish') {
      let content = args.join(' ').trim();
      if (!content && !hasMedia) { await reply(chatId, '⚠️ Usage: /publish <texte>\nOu envoie un média avec /publish en légende.'); }
      else {
        let finalTitle = 'Publication admin';
        let finalContent = content;
        let isAd = false;

        if (content) {
          const geminiKey = Deno.env.get('GEMINI_API_KEY');
          if (geminiKey) {
            await reply(chatId, '⏳ Structuration avec l\'IA...');
            const aiRes = await restructureWithAI(content, geminiKey);
            isAd = aiRes.isAd;
            if (aiRes.title) finalTitle = aiRes.title;
            if (aiRes.content) finalContent = aiRes.content;
          }
        }
        
        if (isAd) {
          await reply(chatId, '❌ Ce contenu a été détecté comme une publicité/spam et n\'a pas été publié.');
          return new Response('OK', { status: 200 });
        }

        const uniqueSuffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const uniqueTitle = `${finalTitle} #${uniqueSuffix}`;

        // Automatically append @izynews at the very bottom
        const footer = "\n\n@izynews";
        if (finalContent && !finalContent.includes('@izynews')) {
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
        const { data: inserted, error } = await supabase.from('articles').insert({
          title: uniqueTitle,
          summary: finalContent.substring(0, 500),
          content: finalContent,
          original_url: `https://t.me/admin_publish_${Date.now()}`,
          image_url: imagePublicUrl,
          is_certified: true,
        }).select('id').maybeSingle();

        if (error) { 
            console.error('[Bot] DB Insert Error:', error);
            await reply(chatId, `❌ Erreur DB: ${error.message}`); 
        }
        else {
          await reply(chatId, `✅ Article publié!\n🆔 <code>${inserted?.id?.substring(0, 8)}</code>`);

          // Also forward to output channel
          if (OUTPUT_CHAT_ID) {
            if (hasMedia) {
              // Use copyMessage with new caption
              await copyMessageToChat(OUTPUT_CHAT_ID, chatId, messageId, finalContent);
            } else {
              await fetch(`${BASE}/sendMessage`, {
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: OUTPUT_CHAT_ID, text: finalContent.substring(0, 4096), parse_mode: 'HTML' }),
              });
            }
          }
        }
      }
    }

    // ── /sources ──────────────────────────────────────────────────────────
    else if (command === '/sources') {
      const { data: sources } = await supabase.from('sources').select('id, name, type, config, is_active')
        .order('created_at', { ascending: false });
      if (!sources?.length) { await reply(chatId, '📭 Aucune source.'); }
      else {
        const lines = sources.map(s => {
          const icon = s.is_active ? '🟢' : '🔴';
          const channel = s.config?.channel || '';
          return `${icon} <code>${s.id.substring(0, 8)}</code> — <b>${s.name}</b> [${s.type}${channel ? ': @' + channel : ''}]`;
        });
        await reply(chatId, `📡 <b>Sources (${sources.length}):</b>\n\n${lines.join('\n')}`);
      }
    }

    // ── /addsource ────────────────────────────────────────────────────────
    else if (command === '/addsource') {
      let channel = args[0]?.trim();
      if (!channel) { await reply(chatId, '⚠️ Usage: /addsource <@canal ou URL_TME>'); }
      else {
        if (channel.includes('t.me/')) {
          const parts = channel.split('t.me/');
          channel = parts[parts.length - 1].split('/')[0].split('?')[0];
        }
        channel = channel.replace(/^@/, '').toLowerCase();

        const { error } = await supabase.from('sources').insert({
          name: `@${channel}`,
          type: 'telegram',
          config: { channel },
          is_active: true,
        });
        if (error) { await reply(chatId, `❌ Erreur: ${error.message}`); }
        else { 
            await reply(chatId, `✅ Source ajoutée avec succès!\n📡 Canal: <b>@${channel}</b>\n\nL'agrégation automatique récupérera les prochaines nouvelles.`); 
        }
      }
    }

    // ── /delsource ────────────────────────────────────────────────────────
    else if (command === '/delsource') {
      if (!args[0]) { await reply(chatId, '⚠️ Usage: /delsource &lt;id&gt;'); }
      else {
        const { data: src } = await supabase.from('sources').select('id, name')
          .ilike('id', `${args[0]}%`).limit(1).maybeSingle();
        if (!src) { await reply(chatId, '❌ Source non trouvée.'); }
        else {
          await supabase.from('sources').update({ is_active: false }).eq('id', src.id);
          await reply(chatId, `✅ Source désactivée: <b>${src.name}</b>`);
        }
      }
    }

    // ── /run ──────────────────────────────────────────────────────────────
    else if (command === '/run') {
      await reply(chatId, '⏳ Agrégation en cours...');
      const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      const res = await fetch(`${supabaseUrl}/functions/v1/aggregate_news`, {
        method: 'POST',
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
        console.error('[Bot] /run aggregate_news HTTP error:', res.status, raw?.slice(0, 500));
        await reply(chatId, `❌ Erreur d'agrégation (HTTP ${res.status}). Vérifie les logs Supabase.`);
        return new Response('OK', { status: 200 });
      }

      if (!result) {
        console.error('[Bot] /run aggregate_news invalid JSON:', raw?.slice(0, 500));
        await reply(chatId, `❌ Erreur d'agrégation: réponse invalide (non-JSON). Vérifie les logs Supabase.`);
        return new Response('OK', { status: 200 });
      }

      if (result.success) {
        await reply(chatId,
          `✅ Agrégation terminée!\n📊 Traités: <b>${result.processed}</b>\n🆕 Nouveaux: <b>${result.new}</b>`
        );
      } else {
        await reply(chatId, `❌ Erreur d'agrégation: ${result.error || 'inconnue'}`);
      }
    }

    // ── Unknown command ───────────────────────────────────────────────────
    else {
      await reply(chatId, `❓ Commande inconnue. Tape /help pour voir les commandes disponibles.`);
    }

  } catch (err) {
    console.error('[Bot] Error:', err);
    await reply(chatId, `💥 Erreur serveur: ${(err as Error).message}`);
  }

  return new Response('OK', { status: 200 });
});
