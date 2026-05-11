-- Create sources table
CREATE TABLE IF NOT EXISTS public.sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- e.g., 'telegram', 'mediastack', 'gnews'
    config JSONB DEFAULT '{}'::jsonb, -- to store channel IDs, API keys, etc.
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create articles table
CREATE TABLE IF NOT EXISTS public.articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT,
    original_url TEXT,
    source_url TEXT,
    source_id UUID REFERENCES public.sources(id) ON DELETE SET NULL,
    is_certified BOOLEAN DEFAULT false,
    image_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(title)
);

-- Enable RLS
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow public read access to articles"
    ON public.articles FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access to sources"
    ON public.sources FOR SELECT
    USING (true);
