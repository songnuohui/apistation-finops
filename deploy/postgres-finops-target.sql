-- Run as a PostgreSQL administrator after creating the independent database:
--   CREATE DATABASE apistation_finops;
-- This file is executed against apistation_finops, never against sub2api.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finops_target_writer') THEN
    CREATE ROLE finops_target_writer LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING' NOINHERIT;
  END IF;
END
$$;

GRANT CONNECT, TEMPORARY ON DATABASE apistation_finops TO finops_target_writer;
CREATE SCHEMA IF NOT EXISTS finops AUTHORIZATION finops_target_writer;
ALTER SCHEMA finops OWNER TO finops_target_writer;
REVOKE ALL ON SCHEMA finops FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA finops TO finops_target_writer;
