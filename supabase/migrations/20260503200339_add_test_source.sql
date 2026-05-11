-- Add a test RSS source
INSERT INTO public.sources (name, type, config, is_active)
VALUES ('Le Monde', 'rss', '{"url": "https://www.lemonde.fr/rss/une.xml"}', true)
ON CONFLICT DO NOTHING;
