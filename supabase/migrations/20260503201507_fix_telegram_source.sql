-- Fix N'ZUI MANTO telegram source channel name
UPDATE public.sources 
SET name = 'N''ZUI MANTO 1', config = '{"channel": "NZUIMANTO1"}'
WHERE name = 'N''ZUI MANTO';
