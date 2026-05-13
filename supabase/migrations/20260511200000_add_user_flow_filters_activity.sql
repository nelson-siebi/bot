-- Add user flow configuration, filters, and activity tracking

ALTER TABLE public.flows
  ADD COLUMN IF NOT EXISTS filters JSONB NOT NULL DEFAULT '{
    "include_keywords": [],
    "exclude_keywords": [],
    "block_ads": true,
    "media_only": false,
    "allow_text": true,
    "allow_photos": true,
    "allow_videos": true,
    "allow_albums": true,
    "use_ai_rewrite": false,
    "remove_links": false,
    "remove_mentions": false,
    "signature_text": ""
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS last_message_id BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_flows_active_last_run
  ON public.flows(is_active, last_run_at);

CREATE TABLE IF NOT EXISTS public.flow_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  flow_id UUID REFERENCES public.flows(id) ON DELETE SET NULL,
  source_id UUID REFERENCES public.user_sources(id) ON DELETE SET NULL,
  target_id UUID REFERENCES public.user_targets(id) ON DELETE SET NULL,
  source_message_id BIGINT,
  target_message_ids BIGINT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'published',
  reason TEXT,
  original_url TEXT,
  text_preview TEXT,
  media_count INTEGER NOT NULL DEFAULT 0,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_activity_user_created_at
  ON public.flow_activity(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_flow_activity_flow_created_at
  ON public.flow_activity(flow_id, created_at DESC);

ALTER TABLE public.flow_activity ENABLE ROW LEVEL SECURITY;
