ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS post_type text NOT NULL DEFAULT 'post',
  ADD COLUMN IF NOT EXISTS is_thread_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_thread_ancestor boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conversation_root_external_id text,
  ADD COLUMN IF NOT EXISTS conversation_root_external_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS parent_external_id text,
  ADD COLUMN IF NOT EXISTS tracked_handle text,
  ADD COLUMN IF NOT EXISTS source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS collection_run_id uuid;

ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_source_kind_check;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_source_kind_check
  CHECK (source_kind = ANY (ARRAY[
    'profile_timeline'::text,
    'thread_reply'::text,
    'thread_ancestor'::text,
    'public_mention_search'::text,
    'manual'::text
  ]));

ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_post_type_check;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_post_type_check
  CHECK (post_type = ANY (ARRAY['post'::text, 'reply'::text, 'quote'::text, 'repost'::text, 'unknown'::text]));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'social_posts_collection_run_id_fkey'
      AND conrelid = 'public.social_posts'::regclass
  ) THEN
    ALTER TABLE public.social_posts
      ADD CONSTRAINT social_posts_collection_run_id_fkey
      FOREIGN KEY (collection_run_id)
      REFERENCES public.social_collection_runs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS social_posts_org_root_published_idx
  ON public.social_posts (organization_id, conversation_root_external_id, published_at DESC)
  WHERE conversation_root_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS social_posts_org_post_type_published_idx
  ON public.social_posts (organization_id, post_type, published_at DESC);

CREATE TABLE IF NOT EXISTS public.social_post_engagement_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  competitor_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'x',
  external_id text NOT NULL,
  tracked_handle text,
  snapshot_at timestamptz NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_metrics jsonb,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  collection_run_id uuid REFERENCES public.social_collection_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_post_engagement_snapshots_platform_check
    CHECK (platform = 'x'),
  CONSTRAINT social_post_engagement_snapshots_post_fkey
    FOREIGN KEY (organization_id, competitor_id, platform, external_id)
    REFERENCES public.social_posts (organization_id, competitor_id, platform, external_id)
    ON DELETE CASCADE,
  CONSTRAINT social_post_engagement_snapshots_unique
    UNIQUE (organization_id, competitor_id, platform, external_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS social_post_engagement_snapshots_org_time_idx
  ON public.social_post_engagement_snapshots (organization_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS social_post_engagement_snapshots_post_time_idx
  ON public.social_post_engagement_snapshots (organization_id, competitor_id, external_id, snapshot_at DESC);

ALTER TABLE public.social_post_engagement_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_post_engagement_snapshots_select_org_members
  ON public.social_post_engagement_snapshots;

CREATE POLICY social_post_engagement_snapshots_select_org_members
  ON public.social_post_engagement_snapshots
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_members om
      WHERE om.organization_id = social_post_engagement_snapshots.organization_id
        AND om.user_id = (SELECT auth.uid())
    )
  );

GRANT SELECT ON public.social_post_engagement_snapshots TO authenticated;
GRANT ALL ON public.social_post_engagement_snapshots TO service_role;

COMMENT ON TABLE public.social_post_engagement_snapshots IS
  'Time-series snapshots of visible X engagement counts; counts are observations, not authoritative lifetime totals.';

COMMENT ON COLUMN public.social_posts.source_payload IS
  'Unmodified source record exported by the authorized X collection pipeline. Kept separately from derived metadata.';

COMMENT ON COLUMN public.social_posts.conversation_root_external_ids IS
  'All observed conversation roots associated with this source post; preserves multi-root conversation context.';

COMMENT ON COLUMN public.social_posts.is_thread_ancestor IS
  'True when the record is a candidate earlier thread ancestor; does not prove a direct reply relationship.';
