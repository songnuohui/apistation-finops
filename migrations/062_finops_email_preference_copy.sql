-- FinOps-owned subscription and unsubscribe copy. This migration never touches Sub2API tables.
ALTER TABLE {{FINOPS_SCHEMA}}.finops_email_settings
  ADD COLUMN IF NOT EXISTS preference_footer_text VARCHAR(255) NOT NULL DEFAULT '这是 FinOps 公告/活动邮件。',
  ADD COLUMN IF NOT EXISTS preference_unsubscribe_label VARCHAR(80) NOT NULL DEFAULT '退订 FinOps 邮件',
  ADD COLUMN IF NOT EXISTS preference_subscribe_label VARCHAR(80) NOT NULL DEFAULT '重新订阅 FinOps 邮件',
  ADD COLUMN IF NOT EXISTS preference_unsubscribed_title VARCHAR(160) NOT NULL DEFAULT '已退订 FinOps 邮件',
  ADD COLUMN IF NOT EXISTS preference_unsubscribed_description VARCHAR(1000) NOT NULL DEFAULT '之后将不再接收 FinOps 的公告和活动邮件。sub2api 的系统邮件不受影响。',
  ADD COLUMN IF NOT EXISTS preference_subscribed_title VARCHAR(160) NOT NULL DEFAULT '已重新订阅 FinOps 邮件',
  ADD COLUMN IF NOT EXISTS preference_subscribed_description VARCHAR(1000) NOT NULL DEFAULT '之后将继续接收 FinOps 的公告和活动邮件。',
  ADD COLUMN IF NOT EXISTS preference_confirm_unsubscribe_title VARCHAR(160) NOT NULL DEFAULT '确认退订 FinOps 邮件',
  ADD COLUMN IF NOT EXISTS preference_confirm_unsubscribe_description VARCHAR(1000) NOT NULL DEFAULT '确认后将不再接收 FinOps 的公告和活动邮件。sub2api 的系统邮件不受影响。',
  ADD COLUMN IF NOT EXISTS preference_confirm_unsubscribe_button VARCHAR(80) NOT NULL DEFAULT '确认退订',
  ADD COLUMN IF NOT EXISTS preference_confirm_subscribe_title VARCHAR(160) NOT NULL DEFAULT '确认重新订阅 FinOps 邮件',
  ADD COLUMN IF NOT EXISTS preference_confirm_subscribe_description VARCHAR(1000) NOT NULL DEFAULT '确认后将继续接收 FinOps 的公告和活动邮件。',
  ADD COLUMN IF NOT EXISTS preference_confirm_subscribe_button VARCHAR(80) NOT NULL DEFAULT '确认重新订阅';
