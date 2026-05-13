-- Pro Plus features: translation, advanced filters, subscription warnings

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS last_subscription_warning_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.flows
  ALTER COLUMN filters SET DEFAULT '{
    "include_keywords": [],
    "exclude_keywords": [],
    "block_ads": false,
    "media_only": false,
    "allow_text": true,
    "allow_photos": true,
    "allow_videos": true,
    "allow_albums": true,
    "use_ai_rewrite": false,
    "remove_links": false,
    "remove_mentions": false,
    "signature_text": "",
    "translate_enabled": false,
    "target_language": "fr",
    "replacements": {},
    "link_action": "keep",
    "link_replacement": ""
  }'::jsonb;
