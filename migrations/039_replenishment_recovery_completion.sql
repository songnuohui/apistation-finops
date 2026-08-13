-- ApiStation FinOps v0.39: explicit recovery completion sources and claimed-file reconciliation.
-- This migration only changes FinOps-owned tables.

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_recoveries
  ADD COLUMN IF NOT EXISTS completion_source VARCHAR(32) NOT NULL DEFAULT '';

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_recoveries
  DROP CONSTRAINT IF EXISTS replenishment_recoveries_completion_source_check;

ALTER TABLE {{FINOPS_SCHEMA}}.replenishment_recoveries
  ADD CONSTRAINT replenishment_recoveries_completion_source_check
  CHECK (completion_source IN ('','system','manual_claimed'));

UPDATE {{FINOPS_SCHEMA}}.replenishment_recoveries
SET completion_source='system'
WHERE status='recovered'
  AND completion_source='';

UPDATE {{FINOPS_SCHEMA}}.replenishment_recoveries
SET status='recovered',
    completion_source='manual_claimed',
    claim_url_ciphertext='',
    next_retry_at=NULL,
    last_error='',
    recovered_at=COALESCE(recovered_at,claimed_at,last_seen_at,updated_at,NOW()),
    updated_at=NOW()
WHERE status='manual_required'
  AND (
    LOWER(delivery_status) IN ('claimed','taken','downloaded','consumed','picked_up','picked-up')
    OR last_error LIKE '%补发文件已被领取%'
  );
