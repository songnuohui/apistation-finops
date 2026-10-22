#!/usr/bin/env python3
"""Fixed, read-only PostgreSQL exporter. No SQL/credentials are accepted from callers."""
import hashlib
import http.server
import json
import os
import re
import socketserver
import subprocess
import threading
import uuid

INCLUDED = set("""
settings account_groups announcement_reads accounts announcements atlas_schema_revisions
audit_logs batch_image_events auth_identity_channels auth_identity_migration_reports
api_keys auth_identities batch_image_items channel_groups channel_account_stats_pricing_intervals
batch_image_jobs billing_usage_entries channel_account_stats_pricing_rules composite_model_routes
deleted_api_key_audits channels error_passthrough_rules identity_adoption_decisions idempotency_records
ops_alert_rules orphan_allowed_groups_audit passkey_user_handles promo_codes payment_orders
payment_provider_instances passkey_credentials scheduled_test_plans schema_migrations security_secrets
subscription_plans tls_fingerprint_profiles usage_billing_dedup usage_billing_dedup_archive proxies
user_allowed_groups user_avatars user_group_rate_multipliers users user_provider_default_grants
user_platform_quotas user_subscriptions user_affiliates user_attribute_definitions promo_code_usages
user_attribute_values redeem_codes payment_audit_logs user_affiliate_ledger
channel_account_stats_model_pricing channel_monitor_v2_config groups_video_price_backup_220
channel_model_pricing channel_monitors groups channel_pricing_intervals sub2api_plugin_bindings
sub2api_plugin_installations channel_monitor_request_templates pending_auth_sessions
""".split())
EXCLUDED = set("""
ops_system_logs ops_error_logs ops_system_metrics ops_metrics_hourly ops_metrics_daily
ops_alert_events ops_job_heartbeats ops_ingress_reject_aggregates channel_monitor_histories
channel_monitor_daily_rollups channel_monitor_v2_latency_histograms_1m
channel_monitor_v2_latency_histograms_rollup channel_monitor_v2_metrics_1m
channel_monitor_v2_metrics_rollup channel_monitor_v2_user_metrics_1m
channel_monitor_v2_user_metrics_rollup channel_monitor_v2_error_metrics_1m
channel_monitor_v2_error_metrics_rollup content_moderation_logs prompt_audit_events
scheduled_test_results auth_cache_invalidation_outbox channel_monitor_aggregation_watermark
ops_system_log_cleanup_audits prompt_audit_jobs usage_cleanup_tasks
scheduler_outbox usage_dashboard_aggregation_watermark usage_dashboard_daily usage_dashboard_daily_users
usage_dashboard_hourly usage_dashboard_hourly_users channel_monitor_v2_watermarks usage_group_rollup_state
usage_group_daily_rollups gemini_cached_contents
""".split())
PROFILE = 'sub2api-core-v1'
CONTAINER = os.environ.get('BACKUP_SOURCE_CONTAINER', '1Panel-postgresql-ggpg')
DATABASE = os.environ.get('BACKUP_SOURCE_DATABASE', 'sub2api')
SOCKET = os.environ.get('BACKUP_SOURCE_SOCKET', '/run/finops-backup-source/export.sock')
PGOPTIONS = '-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=1000 -c application_name=finops-backup-readonly'
LOCK = threading.Lock()


def identifier(value):
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value):
        raise ValueError('unsupported identifier')
    return '"' + value + '"'


def command(program):
    return ['docker', 'exec', '-i', '-e', 'PGOPTIONS=' + PGOPTIONS, CONTAINER,
            program, '-U', 'postgres', '-d', DATABASE]


class Session:
    def __init__(self):
        self.process = subprocess.Popen(command('psql') + ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def query(self, sql):
        marker = uuid.uuid4().hex
        self.process.stdin.write((sql + '\n\\echo ' + marker + '\n').encode())
        self.process.stdin.flush()
        result = []
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError('read-only query failed')
            if line.strip().decode() == marker:
                break
            result.append(line.decode())
        value = ''.join(result).strip()
        return json.loads(value) if value else None

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.write(b'ROLLBACK;\n\\q\n')
                self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()


CATALOG = """
SELECT jsonb_build_object(
 'database',current_database(),'version',current_setting('server_version'),
 'snapshotAt',transaction_timestamp(),'snapshot',pg_export_snapshot(),
 'tables',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'name',c.relname,'kind',c.relkind,'bytes',pg_total_relation_size(c.oid),
   'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,
      'type',format_type(a.atttypid,a.atttypmod),'generated',a.attgenerated) ORDER BY a.attnum)
      FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
 ) ORDER BY c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition),
 'foreignKeys',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'name',con.conname,'table',src.relname,'target',dst.relname,'targetSchema',dn.nspname,
   'columns',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=src.oid AND a.attnum=k.num),
   'targetColumns',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=dst.oid AND a.attnum=k.num)
 )),'[]') FROM pg_constraint con JOIN pg_class src ON src.oid=con.conrelid
 JOIN pg_namespace sn ON sn.oid=src.relnamespace JOIN pg_class dst ON dst.oid=con.confrelid
 JOIN pg_namespace dn ON dn.oid=dst.relnamespace WHERE con.contype='f' AND sn.nspname='public'),
 'sequences',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',seq.relname,'table',t.relname,
   'column',a.attname,'increment',s.seqincrement)),'[]')
   FROM pg_class seq JOIN pg_sequence s ON s.seqrelid=seq.oid JOIN pg_namespace n ON n.oid=seq.relnamespace
   JOIN pg_depend d ON d.objid=seq.oid AND d.classid='pg_class'::regclass AND d.deptype IN ('a','i')
   JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
   WHERE n.nspname='public')
);
"""


def plan(meta):
    names = {t['name'] for t in meta['tables']}
    unknown = sorted(names - INCLUDED - EXCLUDED - {'usage_logs'})
    selected = sorted(names & INCLUDED)
    errors = []
    for table in meta['tables']:
        if table['name'] in selected and table['kind'] != 'r':
            errors.append('partitioned table requires review: ' + table['name'])
    for fk in meta['foreignKeys']:
        if fk['table'] in selected + ['usage_logs'] and (fk['targetSchema'] != 'public' or fk['target'] not in selected + ['usage_logs']):
            errors.append('excluded foreign-key dependency: ' + fk['name'])
        if fk['table'] in selected and fk['target'] == 'usage_logs' and fk['targetColumns'] != ['id']:
            errors.append('unsupported usage reference requires review: ' + fk['name'])
    for seq in meta['sequences']:
        if seq['table'] in selected + ['usage_logs'] and int(seq['increment']) <= 0:
            errors.append('non-increasing sequence requires review')
    if not {'users', 'accounts', 'settings', 'api_keys', 'usage_billing_dedup', 'usage_logs'}.issubset(names):
        errors.append('required source tables are missing')
    return {'profile': PROFILE, 'database': meta['database'], 'version': meta['version'],
            'snapshotAt': meta['snapshotAt'], 'included': selected,
            'excluded': sorted(names & EXCLUDED), 'partial': ['usage_logs'], 'unknown': unknown,
            'physicalBytes': sum(t['bytes'] for t in meta['tables'] if t['name'] in selected),
            'allowed': not unknown and not errors, 'errors': errors}


def reference_condition(fk, source='r', target='u'):
    return ' AND '.join(source + '.' + identifier(a) + '=' + target + '.' + identifier(b)
                        for a, b in zip(fk['columns'], fk['targetColumns']))


def usage_query(meta, selected):
    references = [fk for fk in meta['foreignKeys'] if fk['table'] in selected and fk['target'] == 'usage_logs']
    cols = [c['name'] for t in meta['tables'] if t['name'] == 'usage_logs' for c in t['columns'] if not c['generated']]
    # Start with the small business reference set and look up request rows by primary key.
    needed = ' UNION '.join('SELECT ' + identifier(fk['columns'][0]) + ' AS id FROM public.'
                            + identifier(fk['table']) + ' WHERE ' + identifier(fk['columns'][0])
                            + ' IS NOT NULL' for fk in references)
    query = 'SELECT ' + ','.join('u.' + identifier(c) for c in cols) + ' FROM public.usage_logs u '
    query += 'JOIN (' + needed + ') r ON r.id=u.id ORDER BY u.id' if needed else 'WHERE false'
    return cols, query


def validation_sql(meta, selected):
    result = []
    for fk in meta['foreignKeys']:
        if fk['table'] not in selected or fk['target'] not in selected:
            continue
        nonnull = ' AND '.join('r.' + identifier(a) + ' IS NOT NULL' for a in fk['columns'])
        label = fk['name'].replace("'", "''")
        result.append("DO $check$ BEGIN IF EXISTS (SELECT 1 FROM public." + identifier(fk['table'])
                      + ' r WHERE ' + nonnull + ' AND NOT EXISTS (SELECT 1 FROM public.'
                      + identifier(fk['target']) + ' u WHERE ' + reference_condition(fk)
                      + ")) THEN RAISE EXCEPTION 'Foreign key check failed: " + label + "'; END IF; END $check$;\n")
    return ''.join(result)


class Server(socketserver.ThreadingMixIn, getattr(socketserver, 'UnixStreamServer', socketserver.TCPServer)):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path not in ('/inspect', '/export'):
            self.send_error(404)
            return
        if not LOCK.acquire(blocking=False):
            self.send_error(409)
            return
        session = None
        children = []
        started = False
        timer = threading.Timer(1500, lambda: [p.kill() for p in children if p.poll() is None])
        timer.daemon = True
        timer.start()
        try:
            session = Session()
            children.append(session.process)
            session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')
            meta = session.query(CATALOG)
            summary = plan(meta)
            if self.path == '/inspect':
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(summary).encode())
                return
            if not summary['allowed']:
                self.send_error(409, 'Source schema requires review; inspect the backup source first')
                return
            # Size counters are deliberately not part of the compatibility fingerprint.
            fingerprint = hashlib.sha256(json.dumps({'tables': [{'name': t['name'], 'columns': t['columns']} for t in meta['tables'] if t['name'] in summary['included'] + ['usage_logs']],
                                                      'foreignKeys': sorted(meta['foreignKeys'], key=lambda k: k['name'])}, sort_keys=True).encode()).hexdigest()
            nonce = uuid.uuid4().hex
            manifest = {**summary, 'format': 1, 'schemaFingerprint': fingerprint, 'nonce': nonce,
                        'validationSql': validation_sql(meta, summary['included'] + ['usage_logs'])}
            sequences = []
            for seq in meta['sequences']:
                if seq['table'] not in summary['included'] + ['usage_logs']:
                    continue
                state = session.query("SELECT json_build_object('last',last_value::text) FROM public." + identifier(seq['name']) + ';')
                sequences.append((seq, state['last']))
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.end_headers()
            started = True
            self.wfile.write(('-- FINOPS_BACKUP_METADATA ' + json.dumps(manifest, separators=(',', ':')) + '\n').encode())
            args = command('pg_dump') + ['--data-only', '--no-owner', '--no-privileges', '--no-comments',
                                        '--strict-names', '--lock-wait-timeout=1000', '--snapshot=' + meta['snapshot']]
            for name in summary['included']:
                args.append('--table=public.' + name)
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            children.append(process)
            while True:
                block = process.stdout.read(65536)
                if not block:
                    break
                self.wfile.write(block)
            if process.wait() != 0:
                raise RuntimeError('data-only dump failed')
            cols, query = usage_query(meta, summary['included'])
            columns = ','.join(identifier(c) for c in cols)
            self.wfile.write(('\nCOPY public.usage_logs (' + columns + ') FROM stdin;\n').encode())
            sql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '" + meta['snapshot'] + "'; COPY (" + query + ') TO STDOUT; COMMIT;'
            process = subprocess.Popen(command('psql') + ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            children.append(process)
            while True:
                block = process.stdout.read(65536)
                if not block:
                    break
                self.wfile.write(block)
            if process.wait() != 0:
                raise RuntimeError('referenced usage export failed')
            self.wfile.write(b'\\.\n')
            for seq, last in sequences:
                self.wfile.write(("SELECT pg_catalog.setval('public." + seq['name'] + "', GREATEST(" + str(int(last))
                                  + ', COALESCE((SELECT MAX(' + identifier(seq['column']) + ') FROM public.'
                                  + identifier(seq['table']) + "),0)), true);\n").encode())
            self.wfile.write(('-- FINOPS_EXPORT_COMPLETE ' + nonce + '\n').encode())
        except Exception:
            if not started:
                self.send_error(503, 'Read-only source export failed')
            self.close_connection = True
        finally:
            timer.cancel()
            for process in children[1:]:
                if process.poll() is None:
                    process.kill()
                process.wait()
            if session:
                session.close()
            LOCK.release()


def main():
    if not hasattr(socketserver, 'UnixStreamServer'):
        raise RuntimeError('The read-only exporter requires a Linux Unix socket')
    os.umask(0o077)
    os.makedirs(os.path.dirname(SOCKET), exist_ok=True)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as server:
        os.chown(SOCKET, int(os.environ.get('BACKUP_WORKER_UID', '1000')), -1)
        os.chmod(SOCKET, 0o600)
        server.serve_forever()


if __name__ == '__main__':
    main()
