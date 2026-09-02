-- ApiStation FinOps v0.12: remove the redundant independent monitor history.
--
-- Sub2API is the source of truth for channel monitor state, recent history,
-- and daily rollups. FinOps keeps only monitor display configuration and
-- reads the source data through a read-only connection at request time.

DROP TABLE IF EXISTS {{FINOPS_SCHEMA}}.monitor_group_observations;
