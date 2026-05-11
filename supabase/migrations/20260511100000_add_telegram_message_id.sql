-- Add telegram_message_id to track published messages for deletion
ALTER TABLE public.articles 
ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT,
ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;

-- Index for faster lookups when clearing
CREATE INDEX IF NOT EXISTS idx_articles_telegram_msg 
ON public.articles(telegram_message_id) 
WHERE telegram_message_id IS NOT NULL;
