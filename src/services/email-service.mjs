import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { SupplierCredentialVault } from './supplier-credentials.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const DEFAULT_EMAIL_PREFERENCE_COPY = Object.freeze({
  footerText: '这是 FinOps 公告/活动邮件。',
  unsubscribeLabel: '退订 FinOps 邮件',
  subscribeLabel: '重新订阅 FinOps 邮件',
  unsubscribedTitle: '已退订 FinOps 邮件',
  unsubscribedDescription: '之后将不再接收 FinOps 的公告和活动邮件。sub2api 的系统邮件不受影响。',
  subscribedTitle: '已重新订阅 FinOps 邮件',
  subscribedDescription: '之后将继续接收 FinOps 的公告和活动邮件。',
  confirmUnsubscribeTitle: '确认退订 FinOps 邮件',
  confirmUnsubscribeDescription: '确认后将不再接收 FinOps 的公告和活动邮件。sub2api 的系统邮件不受影响。',
  confirmUnsubscribeButton: '确认退订',
  confirmSubscribeTitle: '确认重新订阅 FinOps 邮件',
  confirmSubscribeDescription: '确认后将继续接收 FinOps 的公告和活动邮件。',
  confirmSubscribeButton: '确认重新订阅',
});

function preferenceCopy(settings = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_EMAIL_PREFERENCE_COPY).map(([key, fallback]) => [
    key, String(settings?.[key] ?? '').trim() || fallback,
  ]));
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret || 'finops-email-preferences-demo').update(value).digest('base64url');
}

export function createEmailPreferenceToken({ userId, email }, config, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    userId: Number(userId),
    email: String(email || '').trim().toLowerCase(),
    exp: Math.floor(now / 1000) + 60 * 60 * 24 * 365,
  })).toString('base64url');
  return `${payload}.${sign(payload, config.sessionSecret)}`;
}

export function decodeEmailPreferenceToken(token, config, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sign(payload, config.sessionSecret));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (value?.v !== 1 || !Number.isSafeInteger(Number(value.userId)) || Number(value.userId) <= 0
      || !EMAIL_RE.test(value.email) || !Number.isInteger(value.exp) || value.exp <= Math.floor(now / 1000)) return null;
    return { userId: Number(value.userId), email: value.email };
  } catch { return null; }
}

function stripUnsafeMarkup(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:script|style|iframe|object|embed|form|input|button|textarea|select|link|meta)[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, '')
    .slice(0, 500000);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

export class EmailService {
  constructor(repository, config) {
    this.repository = repository;
    this.config = config;
    this.vault = new SupplierCredentialVault(config.emailCredentialsKey);
  }

  status(settings) {
    return {
      enabled: Boolean(settings?.enabled),
      configured: Boolean(settings?.smtpHost && settings?.fromEmail && settings?.credentialsConfigured),
      smtpHost: settings?.smtpHost || '',
      smtpPort: Number(settings?.smtpPort || 587),
      smtpSecure: Boolean(settings?.smtpSecure),
      smtpUsername: settings?.smtpUsername || '',
      fromEmail: settings?.fromEmail || '',
      fromName: settings?.fromName || '',
      credentialsConfigured: Boolean(settings?.credentialsConfigured),
      ...preferenceCopy(settings),
      updatedAt: settings?.updatedAt || null,
    };
  }

  encryptPassword(password) { return this.config.demoMode ? 'demo-encrypted' : this.vault.encrypt({ password }); }

  decryptPassword(ciphertext) {
    if (ciphertext === 'demo-encrypted') return 'demo-password';
    if (!ciphertext) return '';
    return String(this.vault.decrypt(ciphertext)?.password || '');
  }

  async createCampaign(input, actor) {
    const htmlContent = stripUnsafeMarkup(input.htmlContent);
    return this.repository.createEmailCampaign({
      ...input,
      htmlContent,
      textContent: input.textContent || htmlToText(htmlContent),
    }, actor);
  }

  async preferenceAction(token, action) {
    const value = decodeEmailPreferenceToken(token, this.config);
    if (!value) throw Object.assign(new Error('退订链接无效或已过期'), { statusCode: 400 });
    if (!['subscribe', 'unsubscribe'].includes(action)) throw Object.assign(new Error('invalid preference action'), { statusCode: 400 });
    const subscribed = action === 'subscribe';
    const preference = await this.repository.setEmailPreference(value.userId, value.email, subscribed, 'public_link');
    return { ...preference, action };
  }

  decodePreference(token) { return decodeEmailPreferenceToken(token, this.config); }

  renderPreferencePage(result, settings = {}) {
    const copy = preferenceCopy(settings);
    const title = result.subscribed ? copy.subscribedTitle : copy.unsubscribedTitle;
    const detail = result.subscribed ? copy.subscribedDescription : copy.unsubscribedDescription;
    const oppositeAction = result.subscribed ? 'unsubscribe' : 'subscribe';
    const oppositeLabel = result.subscribed ? copy.unsubscribeLabel : copy.subscribeLabel;
    const token = createEmailPreferenceToken({ userId: result.sourceUserId, email: result.email }, this.config);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f3f6fa;color:#17263d;font:16px/1.6 Arial,sans-serif}.box{max-width:520px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #dbe5f0;border-radius:10px;box-shadow:0 12px 35px #203b5d12}h1{font-size:22px;margin:0 0 12px}p{color:#607087}a{color:#1769d5}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><a href="/email/preferences?action=${oppositeAction}&t=${encodeURIComponent(token)}">${escapeHtml(oppositeLabel)}</a></p></main></body></html>`;
  }

  renderPreferenceConfirmation(value, action, settings = {}) {
    const copy = preferenceCopy(settings);
    const subscribe = action === 'subscribe';
    const title = subscribe ? copy.confirmSubscribeTitle : copy.confirmUnsubscribeTitle;
    const detail = subscribe ? copy.confirmSubscribeDescription : copy.confirmUnsubscribeDescription;
    const label = subscribe ? copy.confirmSubscribeButton : copy.confirmUnsubscribeButton;
    const token = createEmailPreferenceToken(value, this.config);
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f3f6fa;color:#17263d;font:16px/1.6 Arial,sans-serif}.box{max-width:520px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #dbe5f0;border-radius:10px;box-shadow:0 12px 35px #203b5d12}h1{font-size:22px;margin:0 0 12px}p{color:#607087}button{padding:10px 18px;border:0;border-radius:7px;background:#1769d5;color:#fff;font-size:15px;cursor:pointer}</style></head><body><main class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><form method="post" action="/email/preferences?action=${action}&t=${encodeURIComponent(token)}"><button type="submit">${escapeHtml(label)}</button></form></main></body></html>`;
  }

  preferenceUrl(userId, email, action) {
    const token = createEmailPreferenceToken({ userId, email }, this.config);
    const base = this.config.finopsPublicUrl || '';
    return `${base}/email/preferences?action=${action}&t=${encodeURIComponent(token)}`;
  }

  wrapHtml(html, userId, email, settings = {}) {
    const copy = preferenceCopy(settings);
    const safe = stripUnsafeMarkup(html);
    const unsubscribe = this.preferenceUrl(userId, email, 'unsubscribe');
    const subscribe = this.preferenceUrl(userId, email, 'subscribe');
    return `${safe}<hr style="margin-top:32px;border:0;border-top:1px solid #e5e7eb"><p style="font:12px/1.6 Arial,sans-serif;color:#6b7280">${escapeHtml(copy.footerText)} <a href="${unsubscribe}">${escapeHtml(copy.unsubscribeLabel)}</a> · <a href="${subscribe}">${escapeHtml(copy.subscribeLabel)}</a></p>`;
  }

  async test(settings, to) {
    const password = this.decryptPassword(settings.credentialsCiphertext);
    if (!password) throw Object.assign(new Error('SMTP 密码尚未配置'), { statusCode: 400 });
    const transport = nodemailer.createTransport({
      host: settings.smtpHost, port: Number(settings.smtpPort), secure: Boolean(settings.smtpSecure),
      auth: { user: settings.smtpUsername, pass: password },
      connectionTimeout: this.config.sub2apiAuthTimeoutMs,
    });
    await transport.verify();
    await transport.sendMail({ from: { address: settings.fromEmail, name: settings.fromName || undefined }, to, subject: 'FinOps SMTP 测试邮件', text: 'FinOps SMTP 配置测试成功。' });
    transport.close();
  }

  async emailTransportSettings() {
    const settings = await this.repository.getEmailSettings({ includeCredentials: true });
    if (!settings.enabled || !settings.smtpHost || !settings.fromEmail || !settings.credentialsCiphertext) {
      throw Object.assign(new Error('请先启用并完整配置 FinOps SMTP'), { statusCode: 400 });
    }
    const password = this.decryptPassword(settings.credentialsCiphertext);
    if (!password) throw Object.assign(new Error('SMTP 密码尚未配置'), { statusCode: 400 });
    return { settings, password };
  }

  async sendCampaign(campaignId, { resume = false } = {}) {
    const { settings, password } = await this.emailTransportSettings();
    const campaign = resume
      ? await this.repository.resumeEmailCampaign(campaignId)
      : await this.repository.markEmailCampaignSending(campaignId);
    return this.deliverCampaign(campaignId, campaign, settings, password);
  }

  async deliverCampaign(campaignId, campaign, settings, password) {
    const transport = nodemailer.createTransport({
      host: settings.smtpHost, port: Number(settings.smtpPort), secure: Boolean(settings.smtpSecure),
      auth: { user: settings.smtpUsername, pass: password },
      connectionTimeout: this.config.sub2apiAuthTimeoutMs,
    });
    try {
      const recipients = await this.repository.listPendingEmailRecipients(campaignId);
      for (const recipient of recipients) {
        if (recipient.excludeFromBalanceStats) {
          await this.repository.updateEmailRecipientStatus(recipient.id, 'skipped_whitelist', '白名单用户');
          continue;
        }
        if (!recipient.active) {
          await this.repository.updateEmailRecipientStatus(recipient.id, 'skipped_inactive', '用户已停用或删除');
          continue;
        }
        if (!recipient.subscribed) {
          await this.repository.updateEmailRecipientStatus(recipient.id, 'skipped_unsubscribed', '用户已退订');
          continue;
        }
        if (!EMAIL_RE.test(recipient.email)) {
          await this.repository.updateEmailRecipientStatus(recipient.id, 'skipped_invalid', '邮箱格式无效');
          continue;
        }
        const claimed = await this.repository.markEmailRecipientSending(recipient.id);
        if (!claimed) continue;
        try {
          const html = this.wrapHtml(campaign.htmlContent, recipient.sourceUserId, recipient.email, settings);
          const copy = preferenceCopy(settings);
          await transport.sendMail({
            from: { address: settings.fromEmail, name: settings.fromName || undefined },
            to: recipient.email,
            subject: campaign.subject,
            html,
            text: `${campaign.textContent || htmlToText(campaign.htmlContent)}\n\n${copy.footerText}\n${copy.unsubscribeLabel}：${this.preferenceUrl(recipient.sourceUserId, recipient.email, 'unsubscribe')}\n${copy.subscribeLabel}：${this.preferenceUrl(recipient.sourceUserId, recipient.email, 'subscribe')}`,
            headers: { 'List-Unsubscribe': `<${this.preferenceUrl(recipient.sourceUserId, recipient.email, 'unsubscribe')}>` },
          });
          await this.repository.updateEmailRecipientStatus(recipient.id, 'sent', '');
        } catch (error) {
          await this.repository.updateEmailRecipientStatus(recipient.id, 'failed', String(error?.message || error).slice(0, 1000));
        }
      }
      return this.repository.finishEmailCampaign(campaignId);
    } catch (error) {
      try { await this.repository.markEmailCampaignInterrupted(campaignId); } catch (recoveryError) { console.error('[email recovery]', recoveryError); }
      throw error;
    } finally {
      transport.close();
    }
  }

  async queueCampaign(campaignId, { resume = false } = {}) {
    const { settings, password } = await this.emailTransportSettings();
    const campaign = resume
      ? await this.repository.resumeEmailCampaign(campaignId)
      : await this.repository.markEmailCampaignSending(campaignId);
    setImmediate(() => this.deliverCampaign(campaignId, campaign, settings, password)
      .catch((error) => console.error('[email delivery]', error)));
    return campaign;
  }

  async recoverInterruptedCampaigns() {
    return this.repository.recoverInterruptedEmailCampaigns();
  }
}
