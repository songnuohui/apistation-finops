import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoRepository } from '../src/repositories/demo-repository.mjs';
import { EmailService, createEmailPreferenceToken, decodeEmailPreferenceToken } from '../src/services/email-service.mjs';
import { normalizeEmailCampaign, normalizeEmailSettings } from '../src/http/validation.mjs';

const config = { demoMode: true, sessionSecret: 'email-test-secret', emailCredentialsKey: '', finopsPublicUrl: 'https://finops.example.com', sub2apiAuthTimeoutMs: 1000 };

test('email validation keeps SMTP and campaign payloads bounded', () => {
  assert.equal(normalizeEmailSettings({ enabled: true, smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true, smtpUsername: 'mailer@example.com', smtpPassword: 'secret', fromEmail: 'mailer@example.com' }).smtpPort, 465);
  assert.throws(() => normalizeEmailSettings({ enabled: true, smtpHost: 'smtp.example.com', smtpPort: 587, smtpUsername: 'mailer@example.com', fromEmail: 'mailer@example.com' }), /smtpPassword/);
  assert.equal(normalizeEmailCampaign({ subject: '公告', htmlContent: '<p>内容</p>', recipientMode: 'all' }).category, 'announcement');
  assert.throws(() => normalizeEmailCampaign({ subject: '公告', htmlContent: '<p>内容</p>', recipientMode: 'selected', userIds: [] }), /userIds/);
});

test('email preference token is signed and rejects tampering', () => {
  const token = createEmailPreferenceToken({ userId: 7, email: 'user@example.com' }, config, Date.parse('2026-08-01T00:00:00Z'));
  assert.deepEqual(decodeEmailPreferenceToken(token, config, Date.parse('2026-08-02T00:00:00Z')), { userId: 7, email: 'user@example.com' });
  assert.equal(decodeEmailPreferenceToken(`${token}x`, config), null);
  assert.equal(decodeEmailPreferenceToken(token, config, Date.parse('2027-08-02T00:00:00Z')), null);
});

test('demo email campaign snapshots recipients and keeps preferences FinOps-only', async () => {
  const repository = new DemoRepository(config);
  const service = new EmailService(repository, config);
  await repository.setEmailPreference(1, 'nuohuisong@gmail.com', false);
  const campaign = await service.createCampaign({ subject: '测试', category: 'announcement', htmlContent: '<script>alert(1)</script><p>你好</p>', textContent: '', recipientMode: 'all', userIds: [] }, 'tester');
  assert.equal(campaign.totalCount, 8);
  const result = await service.preferenceAction(new URL(service.preferenceUrl(1, 'nuohuisong@gmail.com', 'subscribe')).searchParams.get('t'), 'subscribe');
  assert.equal(result.subscribed, true);
  assert.match(campaign.htmlContent, /<p>你好<\/p>/);
  assert.doesNotMatch(campaign.htmlContent, /script/);
});

test('preference confirmation is read-only until the action is submitted', async () => {
  const repository = new DemoRepository(config);
  const service = new EmailService(repository, config);
  const token = new URL(service.preferenceUrl(1, 'nuohuisong@gmail.com', 'unsubscribe')).searchParams.get('t');

  const value = service.decodePreference(token);
  const confirmation = service.renderPreferenceConfirmation(value, 'unsubscribe');
  assert.match(confirmation, /method="post"/);
  assert.equal((await repository.listEmailPreferences()).items[0].subscribed, true);

  const result = await service.preferenceAction(token, 'unsubscribe');
  assert.equal(result.subscribed, false);
  assert.equal((await repository.listEmailPreferences()).items[0].subscribed, false);
});

test('email preference filters combine whitelist and subscription state', async () => {
  const repository = new DemoRepository(config);
  repository.users[0].excludeFromBalanceStats = true;
  await repository.setEmailPreference(repository.users[1].id, repository.users[1].email, false);

  const whitelist = await repository.listEmailPreferences({ whitelist: 'excluded' });
  assert.deepEqual(whitelist.items.map((item) => item.sourceUserId), [1]);
  assert.equal(whitelist.summary.whitelistCount, 1);

  const unsubscribed = await repository.listEmailPreferences({ whitelist: 'included', subscribed: 'false', pageSize: 20 });
  assert.deepEqual(unsubscribed.items.map((item) => item.sourceUserId), [21]);
  assert.equal(unsubscribed.summary.unsubscribedCount, 1);
});

test('subscription copy is customizable without changing signed preference links', () => {
  const repository = new DemoRepository(config);
  const service = new EmailService(repository, config);
  const settings = {
    footerText: '品牌通知',
    unsubscribeLabel: '停止接收',
    subscribeLabel: '继续接收',
    unsubscribedTitle: '你已停止接收',
    unsubscribedDescription: '退订成功。',
    subscribedTitle: '你已恢复接收',
    subscribedDescription: '订阅成功。',
    confirmUnsubscribeTitle: '确定停止接收？',
    confirmUnsubscribeDescription: '确认后不再发送。',
    confirmUnsubscribeButton: '确认停止',
    confirmSubscribeTitle: '确定继续接收？',
    confirmSubscribeDescription: '确认后继续发送。',
    confirmSubscribeButton: '确认继续',
  };
  const token = new URL(service.preferenceUrl(1, 'nuohuisong@gmail.com', 'unsubscribe')).searchParams.get('t');
  assert.match(service.renderPreferenceConfirmation(service.decodePreference(token), 'unsubscribe', settings), /确定停止接收？/);
  assert.match(service.renderPreferencePage({ sourceUserId: 1, email: 'nuohuisong@gmail.com', subscribed: false }, settings), /你已停止接收/);
  assert.match(service.wrapHtml('<p>公告</p>', 1, 'nuohuisong@gmail.com', settings), /品牌通知/);
  assert.match(service.wrapHtml('<p>公告</p>', 1, 'nuohuisong@gmail.com', settings), /停止接收/);
});
