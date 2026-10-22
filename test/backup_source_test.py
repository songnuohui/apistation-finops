import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('backup_source', pathlib.Path(__file__).parents[1] / 'scripts' / 'backup-source.py')
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


def metadata():
    return {'database': 'sub2api', 'version': '15', 'snapshotAt': '2026-10-22T00:00:00Z',
            'tables': [{'name': name, 'kind': 'r', 'bytes': 1} for name in source.INCLUDED | source.EXCLUDED | {'usage_logs'}],
            'foreignKeys': [{'name': 'billing_usage_fk', 'table': 'billing_usage_entries', 'target': 'usage_logs',
                             'targetSchema': 'public', 'columns': ['usage_log_id'], 'targetColumns': ['id']}], 'sequences': []}


class BackupSourceTests(unittest.TestCase):
    def test_profile_preserves_financial_data_and_excludes_logs(self):
        plan = source.plan(metadata())
        self.assertTrue(plan['allowed'])
        for name in ['usage_billing_dedup', 'usage_billing_dedup_archive', 'billing_usage_entries', 'payment_audit_logs', 'accounts', 'settings']:
            self.assertIn(name, plan['included'])
        self.assertNotIn('usage_logs', plan['included'])
        self.assertIn('ops_system_logs', plan['excluded'])
        self.assertTrue(source.INCLUDED.isdisjoint(source.EXCLUDED))

    def test_unknown_tables_and_excluded_dependencies_stop_backup(self):
        meta = metadata()
        meta['tables'].append({'name': 'new_business_table', 'kind': 'r', 'bytes': 0})
        self.assertFalse(source.plan(meta)['allowed'])
        meta = metadata()
        meta['foreignKeys'][0]['target'] = 'ops_system_logs'
        self.assertFalse(source.plan(meta)['allowed'])
        meta = metadata()
        meta['tables'] = [t for t in meta['tables'] if t['name'] != 'accounts']
        self.assertFalse(source.plan(meta)['allowed'])

    def test_composite_foreign_keys_have_explicit_target_validation(self):
        fk = {'name': 'composite_fk', 'table': 'api_keys', 'target': 'users', 'columns': ['x', 'y'], 'targetColumns': ['a', 'b']}
        sql = source.validation_sql({'foreignKeys': [fk]}, ['api_keys', 'users'])
        self.assertIn('r."x"=u."a" AND r."y"=u."b"', sql)
        self.assertIn('RAISE EXCEPTION', sql)
        self.assertIn('IS NOT NULL', sql)

    def test_source_command_is_fixed_readonly_and_never_contains_a_password(self):
        cmd = source.command('psql')
        self.assertIn('default_transaction_read_only=on', ' '.join(cmd))
        self.assertIn('lock_timeout=1000', ' '.join(cmd))
        self.assertNotIn('password', ' '.join(cmd))
        for name in ['bad.name', 'users;DELETE', 'x"y']:
            with self.assertRaises(ValueError):
                source.identifier(name)

    def test_required_usage_uses_business_references_and_primary_key(self):
        meta = metadata()
        for table in meta['tables']:
            table['columns'] = [{'name': 'id', 'generated': ''}, {'name': 'amount', 'generated': ''}]
        cols, sql = source.usage_query(meta, ['billing_usage_entries'])
        self.assertEqual(cols, ['id', 'amount'])
        self.assertIn('SELECT "usage_log_id" AS id FROM public."billing_usage_entries"', sql)
        self.assertIn('r.id=u.id', sql)
        self.assertNotIn('EXISTS', sql)
        self.assertIn('WHERE false', source.usage_query(meta, [])[1])
        meta['foreignKeys'][0]['targetColumns'] = ['other']
        self.assertFalse(source.plan(meta)['allowed'])


if __name__ == '__main__':
    unittest.main()
