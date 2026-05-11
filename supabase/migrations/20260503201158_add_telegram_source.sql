-- Add N'ZUI MANTO telegram source
INSERT INTO public.sources (name, type, config, is_active)
VALUES ('N''ZUI MANTO', 'telegram', '{"channel": "nzuimanto"}', true)
ON CONFLICT DO NOTHING;
