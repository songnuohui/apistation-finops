const CODE_MESSAGES = Object.freeze({
  protected_sub2api_blocked: '已阻止连接生产环境 Sub2API 地址',
  insecure_protocol_blocked: '供应商连接必须使用 HTTPS',
  private_address_blocked: '供应商地址解析到了内网或保留地址，无法连接',
  dns_lookup_failed: '供应商域名无法解析，请检查供应商地址和服务器 DNS 配置',
  supplier_redirect: '供应商接口地址发生跳转，请更新供应商连接地址',
  invalid_json: '供应商返回了无法识别的数据，请检查接口地址',
  authentication_failed: '供应商认证失败，请检查账号、密码或密钥',
  missing_credentials: '供应商认证信息不完整，请补充账号、密码或密钥',
  request_failed: '无法连接供应商，请检查地址和网络状态',
  timeout: '连接供应商超时，请检查地址和网络状态',
  remote_error: '供应商返回了错误',
  unsupported_site: '供应商站点暂不支持',
  adapter_required: '无法识别供应商类型，请选择适配器',
  unsupported_adapter: '当前供应商暂不支持巡检',
  raw_key_unavailable: '当前密钥无法用于主动探测',
  raw_key_not_requested: '当前巡检不会读取供应商密钥原文',
  model_discovery_failed: '无法读取供应商模型列表',
  token_rejected: '供应商拒绝了该密钥',
  response_too_large: '供应商返回的数据过大',
  http_error: '供应商请求失败',
  two_factor_required: '供应商需要双重验证，请补充验证配置',
  turnstile_required: '供应商要求完成安全验证，请改用访问令牌或其他登录方式',
  invalid_billing_response: '供应商返回的计费信息无法识别',
  invalid_multiplier: '供应商返回的倍率无效',
  key_not_found: '供应商密钥已不在最新列表中',
  first_token_missing: '供应商没有返回首个响应内容',
});

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''));
}

export function supplierUserMessage(value, { code = '', httpStatus = 0 } = {}) {
  const text = String(value || '').trim();
  const normalized = text.toLowerCase();
  const status = Number(httpStatus || 0);

  if (normalized.includes('hostname could not be resolved')) return CODE_MESSAGES.dns_lookup_failed;
  if (normalized.includes('private or reserved address')) return CODE_MESSAGES.private_address_blocked;
  if (normalized.includes('production sub2api host')) return CODE_MESSAGES.protected_sub2api_blocked;
  if (normalized.includes('supplier monitoring requires https')) return CODE_MESSAGES.insecure_protocol_blocked;
  if (normalized.includes('supplier response is too large') || normalized.includes('response is too large')) return CODE_MESSAGES.response_too_large;
  if (normalized.includes('supplier returned text/html') || normalized.includes('a non-json response')) {
    return `供应商返回了非 JSON 数据（HTTP ${status || '未知'}），请检查接口地址`;
  }
  if (normalized.includes('supplier moved this api') || normalized.includes('http ') && normalized.includes('redirect')) {
    const target = text.match(/https?:\/\/[^\s;]+/i)?.[0] || '';
    return target ? `供应商接口地址发生跳转，请将连接地址更新为 ${target}` : CODE_MESSAGES.supplier_redirect;
  }
  if (normalized.includes('could not connect to supplier') || normalized.includes('could not read supplier')) {
    return CODE_MESSAGES.request_failed;
  }
  if (normalized.includes('supplier request timed out') || normalized.includes('supplier model probe timed out')) {
    return CODE_MESSAGES.timeout;
  }
  if (normalized.includes('supplier site was not recognized')) return CODE_MESSAGES.unsupported_site;
  if (normalized.includes('this supplier requires a dedicated adapter')) return CODE_MESSAGES.adapter_required;
  if (normalized.includes('supplier authentication did not return a usable token or session')) return CODE_MESSAGES.authentication_failed;
  if (normalized.includes('user id required')) return '供应商登录返回的信息缺少用户标识，请检查供应商版本或登录配置';
  if (normalized.includes('neither an access token nor a session cookie')) return '供应商认证没有返回可用令牌，请检查登录配置';
  if (normalized.includes('turnstile') || normalized.includes('captcha') || normalized.includes('challenge')) return CODE_MESSAGES.turnstile_required;
  if (normalized.includes('totp secret is required')) return CODE_MESSAGES.two_factor_required;
  if (normalized.includes('access token is not configured') || normalized.includes('refresh token is not configured')
    || normalized.includes('username and password are not configured') || normalized.includes('api key is not configured')) {
    return CODE_MESSAGES.missing_credentials;
  }
  if (normalized.includes('selected supplier key is not available') || normalized.includes('inventory did not provide a usable raw api key')
    || normalized.includes('did not allow the selected key')) return CODE_MESSAGES.raw_key_unavailable;
  if (normalized.includes('per-key checks do not retrieve plaintext keys')) return CODE_MESSAGES.raw_key_not_requested;
  if (normalized.includes('billing metadata response is invalid')) return CODE_MESSAGES.invalid_billing_response;
  if (normalized.includes('billing metadata returned an invalid multiplier')) return CODE_MESSAGES.invalid_multiplier;
  if (normalized.includes('selected supplier key is not present in the latest inventory')) return CODE_MESSAGES.key_not_found;
  if (normalized.includes('no check adapter')) return CODE_MESSAGES.unsupported_adapter;
  if (normalized.includes('selected supplier key could not list models')) return CODE_MESSAGES.model_discovery_failed;
  if (normalized.includes('model listing rejected')) return CODE_MESSAGES.token_rejected;
  if (normalized.includes('api key authentication failed')) return CODE_MESSAGES.authentication_failed;
  if (normalized.includes('authentication failed') || normalized.includes('rejected login')) return CODE_MESSAGES.authentication_failed;
  if (normalized.includes('http ') && /\b\d{3}\b/.test(normalized)) return `${CODE_MESSAGES.http_error}（HTTP ${status || '未知'}）`;

  if (hasChinese(text)) return text;

  return CODE_MESSAGES[code] || (text ? '供应商连接失败，请检查供应商配置和网络状态' : '');
}

export function profitGuardGroupLabel(groupName, groupId) {
  const name = String(groupName || '').trim();
  return name || (groupId ? `分组 #${groupId}` : '未命名分组');
}

export function profitGuardAlertCopy({ action, groupName, groupId, accountName, accountId, reason = '' }) {
  const group = profitGuardGroupLabel(groupName, groupId);
  const account = String(accountName || '').trim() || `账号 ${accountId || ''}`.trim();
  const actionLabel = action === 'add_group'
    ? `已自动添加分组“${group}”`
    : action === 'blocked_last_group'
      ? `未移除分组“${group}”`
      : `已自动移除分组“${group}”`;
  const title = action === 'add_group'
    ? `已自动添加销售分组“${group}”`
    : action === 'blocked_last_group'
      ? `利润保护未移除分组“${group}”`
      : `已自动移除低利润分组“${group}”`;
  const reasonText = String(reason || '').trim();
  const bodyReason = reasonText.includes(group) ? reasonText : `分组“${group}”：${reasonText}`;
  return { title, message: `${account}：${actionLabel}。${bodyReason}` };
}
