import test from 'node:test';
import assert from 'node:assert/strict';
import {
  profitGuardAlertCopy,
  supplierUserMessage,
} from '../src/services/supplier-messages.mjs';

test('supplier network errors are presented in Chinese', () => {
  assert.equal(
    supplierUserMessage('GET /api/status: supplier hostname could not be resolved', { code: 'dns_lookup_failed' }),
    '供应商域名无法解析，请检查供应商地址和服务器 DNS 配置',
  );
  assert.equal(
    supplierUserMessage('GET /v1/models: supplier returned text/html with HTTP 502', { code: 'invalid_json', httpStatus: 502 }),
    '供应商返回了非 JSON 数据（HTTP 502），请检查接口地址',
  );
  assert.equal(
    supplierUserMessage('supplier request timed out', { code: 'timeout' }),
    '连接供应商超时，请检查地址和网络状态',
  );
});

test('profit guard alerts include the affected group name in title and message', () => {
  const actions = [
    ['add_group', '已自动添加销售分组“ChatGPT-Plus”', '已自动添加分组“ChatGPT-Plus”'],
    ['remove_group', '已自动移除低利润分组“ChatGPT-Plus”', '已自动移除分组“ChatGPT-Plus”'],
    ['blocked_last_group', '利润保护未移除分组“ChatGPT-Plus”', '未移除分组“ChatGPT-Plus”'],
  ];
  for (const [action, title, actionText] of actions) {
    const copy = profitGuardAlertCopy({
      action,
      groupName: 'ChatGPT-Plus',
      accountName: '测试账号',
      reason: '分组“ChatGPT-Plus”当前不满足保护条件',
    });
    assert.equal(copy.title, title);
    assert.match(copy.message, new RegExp(actionText));
    assert.match(copy.message, /ChatGPT-Plus/);
  }
});

test('profit guard alerts fall back to a readable group identifier', () => {
  const copy = profitGuardAlertCopy({
    action: 'remove_group',
    groupId: 42,
    accountId: 8,
    reason: '倍率不满足保护条件',
  });
  assert.equal(copy.title, '已自动移除低利润分组“分组 #42”');
  assert.match(copy.message, /账号 8/);
  assert.match(copy.message, /分组 #42/);
});
