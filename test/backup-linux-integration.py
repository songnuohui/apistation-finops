"""Opt-in Docker integration using synthetic data and a local Restic repository only."""
import hashlib
import io
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid

root = pathlib.Path(__file__).resolve().parents[1]
scratch = pathlib.Path(tempfile.mkdtemp(prefix='finops-backup-fixture-'))
suffix = uuid.uuid4().hex[:10]
pg = 'finops-backup-fixture-pg-' + suffix
worker = 'finops-backup-fixture-worker-' + suffix
exporter = None
token = secrets.token_hex(32)


def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stderr.decode()[:2000])
    return result.stdout


def call(route, payload):
    program = "const r=await fetch('http://127.0.0.1:8093'+process.argv[1],{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.FINOPS_BACKUP_WORKER_TOKEN},body:process.argv[2]});if(!r.ok)throw Error(await r.text());process.stdout.write(Buffer.from(await r.arrayBuffer()));"
    return run(['docker', 'exec', worker, 'node', '--input-type=module', '-e', program, route, json.dumps(payload)])


try:
    os.chmod(scratch, 0o755)
    for name in ['socket', 'data']:
        (scratch / name).mkdir()
        os.chown(scratch / name, 1000, 1000)
    wrapper = scratch / 'restic'
    wrapper.write_text('#!/bin/sh\nexport RESTIC_REPOSITORY=/var/lib/finops-backup/fixture-repository\nexec /usr/bin/restic "$@"\n')
    os.chmod(wrapper, 0o755)
    run(['docker', 'run', '-d', '--name', pg, '--network', 'none', '--memory', '256m', '--cpus', '0.25',
         '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=sub2api', 'postgres:15.18-alpine'])
    for _ in range(100):
        if subprocess.run(['docker', 'exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.2)
    sql = '''CREATE TABLE users(id bigserial PRIMARY KEY, balance numeric NOT NULL);
CREATE TABLE accounts(id bigserial PRIMARY KEY, credential text);
CREATE TABLE settings(key text PRIMARY KEY, value text);
CREATE TABLE api_keys(id bigserial PRIMARY KEY, user_id bigint REFERENCES users);
CREATE TABLE usage_logs(id bigserial PRIMARY KEY, user_id bigint REFERENCES users, amount numeric);
CREATE TABLE usage_billing_dedup(id bigserial PRIMARY KEY, request_key text);
CREATE TABLE billing_usage_entries(id bigserial PRIMARY KEY, usage_log_id bigint REFERENCES usage_logs);
CREATE TABLE pending_auth_sessions(id bigserial PRIMARY KEY);
CREATE TABLE identity_adoption_decisions(id bigserial PRIMARY KEY, pending_auth_session_id bigint REFERENCES pending_auth_sessions);
CREATE TABLE ops_system_logs(id bigint, message text);
INSERT INTO users(balance) VALUES(123.45);
INSERT INTO accounts(credential) VALUES('synthetic-secret');
INSERT INTO settings VALUES('synthetic','fixture');
INSERT INTO api_keys(user_id) VALUES(1);
INSERT INTO usage_logs(user_id,amount) VALUES(1,1.2),(1,4.5);
INSERT INTO billing_usage_entries(usage_log_id) VALUES(1);
INSERT INTO usage_billing_dedup(request_key) VALUES('synthetic-request');
INSERT INTO pending_auth_sessions DEFAULT VALUES;
INSERT INTO identity_adoption_decisions(pending_auth_session_id) VALUES(1);
INSERT INTO ops_system_logs VALUES(1,'must-be-excluded');'''
    run(['docker', 'exec', '-i', pg, 'psql', '-U', 'postgres', '-d', 'sub2api', '-v', 'ON_ERROR_STOP=1'], input=sql.encode())
    exporter = subprocess.Popen(['python3', str(root / 'scripts/backup-source.py')], env={**os.environ,
        'BACKUP_SOURCE_CONTAINER': pg, 'BACKUP_SOURCE_SOCKET': str(scratch / 'socket/export.sock')}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if (scratch / 'socket/export.sock').exists():
            break
        time.sleep(0.1)
    run(['docker', 'run', '-d', '--name', worker, '--network', 'none', '--memory', '384m', '--cpus', '0.5',
         '-e', 'FINOPS_BACKUP_WORKER_TOKEN=' + token, '-v', str(scratch / 'socket') + ':/run/source:ro',
         '-v', str(scratch / 'data') + ':/var/lib/finops-backup', '-v', str(wrapper) + ':/usr/local/bin/restic:ro',
         'apistation-finops-backup:review'])
    for _ in range(100):
        try:
            source = json.loads(call('/source', {}))
            assert source['allowed'], source
            break
        except RuntimeError:
            time.sleep(0.1)
    else:
        raise RuntimeError('fixture worker not ready')
    payload = {'settings': {'bucket': 'synthetic-fixture', 'autoPrune': True}, 'secrets': {
        'accessKey': 'synthetic', 'secretKey': 'synthetic', 'password': 'synthetic-fixture-password'}}
    call('/storage/init', payload)
    for iteration in range(2):
        job = str(uuid.uuid4())
        call('/jobs', {**payload, 'id': job})
        for _ in range(300):
            result = json.loads(call('/job-status', {'id': job}))
            if result['status'] in ['failed', 'completed']:
                break
            time.sleep(0.2)
        assert result['status'] == 'completed', result
        assert not result['progress'].get('warning'), result
        print(json.dumps({'iteration': iteration + 1, 'status': result['status'], 'addedBytes': result['progress']['addedBytes']}), flush=True)
    snapshots = json.loads(call('/snapshots', payload))['items']
    assert snapshots, snapshots
    archive = call('/download', {**payload, 'id': snapshots[0]['id']})
    with tarfile.open(fileobj=io.BytesIO(archive)) as package:
        files = {pathlib.PurePosixPath(n.name).name: package.extractfile(n).read() for n in package.getmembers() if n.isfile()}
    assert set(files) == {'data.sql', 'validate.sql', 'manifest.json', 'SHA256SUMS', 'RESTORE.md'}, list(files)
    manifest = json.loads(files['manifest.json'])
    assert manifest['rowCounts']['usage_logs'] == 1, manifest
    assert manifest['rowCounts']['users'] == 1
    assert 'ops_system_logs' not in manifest['rowCounts']
    assert hashlib.sha256(files['data.sql']).hexdigest() == manifest['dataSha256']
    assert b'CREATE TABLE' not in files['data.sql']
    assert b'must-be-excluded' not in files['data.sql']
    for line in files['SHA256SUMS'].decode().splitlines():
        digest, name = line.split('  ')
        assert hashlib.sha256(files[name]).hexdigest() == digest
    assert not (scratch / 'data/staging/current').exists()
    print('PASS: fixed read-only export, empty COPY sections, referenced usage, two snapshots, dedup, check, retention, full TAR and hashes', flush=True)
finally:
    if exporter:
        exporter.terminate()
        exporter.wait(timeout=10)
    for name in [worker, pg]:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(scratch)
