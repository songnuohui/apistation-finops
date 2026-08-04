-- ApiStation FinOps v0.18: align existing Sub2API key links with account cost dimensions.
-- This migration only reads and writes FinOps-owned tables.

WITH linked_keys AS (
  SELECT l.source_account_id,l.supplier_key_id,s.name AS supplier_name,
         LEFT(
           COALESCE(NULLIF(BTRIM(k.name),''),NULLIF(BTRIM(k.masked_key),''),'密钥 '||k.external_key_id)
           || CASE
             WHEN POSITION(k.external_key_id IN COALESCE(NULLIF(BTRIM(k.name),''),NULLIF(BTRIM(k.masked_key),''),''))>0
               THEN ''
             ELSE ' · ID '||k.external_key_id
           END,
           120
         ) AS purchase_batch
  FROM {{FINOPS_SCHEMA}}.supplier_account_links l
  JOIN {{FINOPS_SCHEMA}}.supplier_keys k ON k.id=l.supplier_key_id
  JOIN {{FINOPS_SCHEMA}}.supplier_connections c ON c.id=k.connection_id
  JOIN {{FINOPS_SCHEMA}}.suppliers s ON s.id=c.supplier_id
  WHERE k.removed_at IS NULL AND k.status='active' AND c.enabled
    AND COALESCE(NULLIF(c.detected_adapter_type,''),c.adapter_type)='sub2api'
)
UPDATE {{FINOPS_SCHEMA}}.dim_accounts a
SET supplier=linked.supplier_name,purchase_batch=linked.purchase_batch,synced_at=NOW()
FROM linked_keys linked
WHERE a.source_account_id=linked.source_account_id;

WITH linked_keys AS (
  SELECT l.source_account_id,l.supplier_key_id
  FROM {{FINOPS_SCHEMA}}.supplier_account_links l
  JOIN {{FINOPS_SCHEMA}}.supplier_keys k ON k.id=l.supplier_key_id
  JOIN {{FINOPS_SCHEMA}}.supplier_connections c ON c.id=k.connection_id
  WHERE k.removed_at IS NULL AND k.status='active' AND c.enabled
    AND COALESCE(NULLIF(c.detected_adapter_type,''),c.adapter_type)='sub2api'
)
UPDATE {{FINOPS_SCHEMA}}.account_cost_rules rule
SET supplier_key_id=linked.supplier_key_id,updated_at=NOW()
FROM linked_keys linked
WHERE rule.source_account_id=linked.source_account_id
  AND rule.status='active'
  AND rule.cost_mode='probe_multiplier'
  AND rule.supplier_key_id IS NULL;

WITH linked_keys AS (
  SELECT l.source_account_id,l.supplier_key_id
  FROM {{FINOPS_SCHEMA}}.supplier_account_links l
  JOIN {{FINOPS_SCHEMA}}.supplier_keys k ON k.id=l.supplier_key_id
  JOIN {{FINOPS_SCHEMA}}.supplier_connections c ON c.id=k.connection_id
  WHERE k.removed_at IS NULL AND k.status='active' AND c.enabled
    AND COALESCE(NULLIF(c.detected_adapter_type,''),c.adapter_type)='sub2api'
)
INSERT INTO {{FINOPS_SCHEMA}}.account_cost_rules(
  source_account_id,cost_profile_id,cost_mode,basis_mode,upstream_multiplier,
  selling_multiplier,cny_per_reference_unit,effective_from,status,notes,created_by,
  change_strategy,supplier_key_id)
SELECT linked.source_account_id,NULL,'probe_multiplier','revenue_backsolve',NULL,
       NULL,NULL,NOW(),'active','','system_migration','future_only',linked.supplier_key_id
FROM linked_keys linked
WHERE NOT EXISTS (
    SELECT 1
    FROM {{FINOPS_SCHEMA}}.account_cost_rules rule
    WHERE rule.source_account_id=linked.source_account_id
      AND rule.status='active'
      AND (rule.effective_to IS NULL OR rule.effective_to>NOW())
  )
  AND NOT EXISTS (
    SELECT 1
    FROM {{FINOPS_SCHEMA}}.account_cost_periods period
    WHERE period.source_account_id=linked.source_account_id
      AND period.status='active'
      AND period.effective_to>NOW()
  );

COMMENT ON COLUMN {{FINOPS_SCHEMA}}.account_cost_rules.supplier_key_id IS
  'Sanitized FinOps supplier key that supplied the automatic upstream multiplier.';
