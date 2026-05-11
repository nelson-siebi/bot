-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create the cron job to call the Edge Function every 15 minutes
SELECT cron.schedule(
    'invoke-aggregate-news',
    '*/15 * * * *',
    $$
    SELECT net.http_post(
        url:='https://nxgryaqncfjuazfvekro.supabase.co/functions/v1/aggregate_news',
        headers:='{"Content-Type": "application/json"}'::jsonb
    );
    $$
);
