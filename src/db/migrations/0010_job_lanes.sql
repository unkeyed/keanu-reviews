ALTER TABLE "jobs" ADD COLUMN "lanes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Mirrors jobPrKeys (src/events/lanes.ts). Failed jobs count too: an admin replay requeues them.
UPDATE "jobs" AS j
SET "lanes" = coalesce(
  (
    SELECT array_agg(DISTINCT lower(j."raw" #>> '{repository,full_name}') || '#' || trunc((e.v ->> 'number')::numeric)::text)
    FROM jsonb_array_elements(
      CASE
        WHEN j."event" = 'issue_comment' THEN jsonb_build_array(j."raw" -> 'issue')
        WHEN j."event" IN ('pull_request', 'pull_request_review', 'pull_request_review_comment')
          THEN jsonb_build_array(j."raw" -> 'pull_request')
        WHEN j."event" = 'check_run' AND jsonb_typeof(j."raw" #> '{check_run,pull_requests}') = 'array'
          THEN j."raw" #> '{check_run,pull_requests}'
        ELSE '[]'::jsonb
      END
    ) AS e(v)
    WHERE CASE WHEN jsonb_typeof(e.v -> 'number') = 'number' THEN (e.v ->> 'number')::numeric % 1 = 0 ELSE false END
  ),
  '{}'
)
WHERE j."status" IN ('pending', 'processing', 'failed')
  AND jsonb_typeof(j."raw" #> '{repository,full_name}') = 'string';
