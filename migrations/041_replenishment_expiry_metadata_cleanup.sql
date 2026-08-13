-- Remove obsolete account-expiration metadata from FinOps-owned replenishment items.

UPDATE {{FINOPS_SCHEMA}}.oauth_supply_order_items
SET metadata=metadata-'expiresAt',
    updated_at=NOW()
WHERE metadata ? 'expiresAt';
