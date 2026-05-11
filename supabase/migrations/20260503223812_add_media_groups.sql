CREATE TABLE media_groups (
  media_group_id text NOT NULL,
  message_id integer NOT NULL,
  created_at timestamp with time zone default now()
);
CREATE INDEX idx_media_groups_media_group_id ON media_groups (media_group_id);