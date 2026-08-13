-- Remove empty legacy expiration values. Positive explicit timestamps remain supported.

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items
SET metadata=metadata-'expiresAt',
    updated_at=NOW()
WHERE metadata ? 'expiresAt'
  AND (
    metadata->'expiresAt'='null'::jsonb
    OR BTRIM(metadata->>'expiresAt')=''
    OR (
      jsonb_typeof(metadata->'expiresAt')='number'
      AND (metadata->>'expiresAt')::numeric<=0
    )
  );
