-- Store Telegram bot guided workflow state per user/admin
ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS bot_state JSONB NOT NULL DEFAULT '{}'::jsonb;
