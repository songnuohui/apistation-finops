function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupIdsFromAccount(account) {
  const value = account?.group_ids ?? account?.groupIds ?? account?.groups;
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'object' ? item?.id : item)
      .map(Number).filter((item) => Number.isSafeInteger(item) && item > 0);
  }
  return [];
}

function groupId(group) {
  const value = Number(group?.id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function groupMultiplier(group) {
  return number(group?.rate_multiplier ?? group?.rateMultiplier);
}

function normalizedPlatform(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function groupPlatform(group) {
  return normalizedPlatform(group?.platform ?? group?.channel_type ?? group?.channelType);
}

function groupName(group, id) {
  const name = String(group?.name || '').trim();
  return name || (id ? `分组 #${id}` : '未命名分组');
}

function groupShouldBeAdded(
  upstreamMultiplier,
  group,
  accountPlatform,
  targetMarginMin,
  targetMarginMax,
) {
  const multiplier = groupMultiplier(group);
  const platform = normalizedPlatform(accountPlatform);
  const groupPlatformValue = groupPlatform(group);
  if (
    upstreamMultiplier === null
    || multiplier === null
    || multiplier <= 0
    || !platform
    || !groupPlatformValue
    || platform !== groupPlatformValue
    || targetMarginMin === null
    || targetMarginMax === null
  ) return false;
  const status = String(group?.status || '').trim().toLowerCase();
  if (status && !['active', 'enabled', 'available', 'ok'].includes(status)) return false;
  const margin = 1 - upstreamMultiplier / multiplier;
  const epsilon = 1e-9;
  return margin + epsilon >= targetMarginMin && margin - epsilon <= targetMarginMax;
}

function removalReason({ groupName: name, upstreamMultiplier, groupRateMultiplier, minimumMargin, thresholdMode, minimumSaleMultiplier }) {
  const label = `分组“${name || '未命名分组'}”`;
  if (groupRateMultiplier !== null && groupRateMultiplier <= upstreamMultiplier) {
    return `${label}售价倍率 ${groupRateMultiplier}x 不高于上游成本倍率 ${upstreamMultiplier}x`;
  }
  if (thresholdMode === 'minimum_sale_multiplier') {
    return `${label}售价倍率 ${groupRateMultiplier}x 不高于触发倍率；上游成本倍率 ${upstreamMultiplier}x 已达到触发倍率 ${minimumSaleMultiplier}x`;
  }
  return `${label}预计毛利率低于 ${minimumMargin * 100}%；上游成本倍率为 ${upstreamMultiplier}x`;
}

export function minimumSaleMultiplierForMargin(upstreamMultiplier, minimumMargin) {
  if (upstreamMultiplier === null || minimumMargin === null || minimumMargin < 0 || minimumMargin >= 1) return null;
  return upstreamMultiplier / (1 - minimumMargin);
}

export function groupShouldBeRemoved(
  upstreamMultiplier,
  groupRateMultiplier,
  minimumMargin,
  thresholdMode = 'margin',
  minimumSaleMultiplier = null,
) {
  if (upstreamMultiplier === null || groupRateMultiplier === null || groupRateMultiplier <= 0) return false;
  if (groupRateMultiplier <= upstreamMultiplier) return true;
  if (thresholdMode === 'minimum_sale_multiplier') {
    return minimumSaleMultiplier !== null
      && upstreamMultiplier >= minimumSaleMultiplier
      && groupRateMultiplier <= minimumSaleMultiplier;
  }
  const margin = 1 - upstreamMultiplier / groupRateMultiplier;
  return margin < minimumMargin;
}

export class AccountProfitGuardService {
  constructor(repository, sub2ApiGateway, logger = console) {
    this.repository = repository;
    this.gateway = sub2ApiGateway;
    this.logger = logger;
  }

  async evaluateSupplierConnection(connectionId) {
    const candidates = await this.repository.listProfitGuardCandidates(connectionId);
    if (!candidates.length) return { evaluated: 0, changed: 0 };
    const [groupsPayload] = await Promise.all([this.gateway.listGroups()]);
    const groups = Array.isArray(groupsPayload) ? groupsPayload : groupsPayload?.items || [];
    const groupsById = new Map(groups.map((group) => [groupId(group), group]).filter(([id]) => id));
    let changed = 0;
    for (const candidate of candidates) {
      try {
        const result = await this.evaluateCandidate(candidate, groupsById);
        if (result.changed) changed += 1;
      } catch (error) {
        await this.repository.recordProfitGuardError(candidate.accountId, error?.message || error);
        this.logger.warn('[profit-guard] evaluation failed', candidate.accountId, error?.message || error);
      }
    }
    return { evaluated: candidates.length, changed };
  }

  async evaluateCandidate(candidate, groupsById) {
    const upstream = number(candidate.upstreamMultiplier);
    if (upstream === null || upstream < 0) {
      await this.repository.recordProfitGuardEvaluation(candidate);
      return { changed: false, reason: 'upstream multiplier unavailable' };
    }
    const account = await this.gateway.getAccount(candidate.accountId, { fresh: true });
    const beforeGroupIds = [...new Set(groupIdsFromAccount(account))];
    const removable = beforeGroupIds.filter((id) => {
      const group = groupsById.get(id);
      return groupShouldBeRemoved(
        upstream,
        groupMultiplier(group),
        candidate.minimumMargin,
        candidate.thresholdMode,
        candidate.minimumSaleMultiplier,
      );
    });
    const autoAssign = Boolean(candidate.autoAssignEnabled)
      && candidate.targetMarginMin !== null
      && candidate.targetMarginMax !== null;
    const addable = autoAssign
      ? [...groupsById.values()]
        .filter((group) => {
          const id = groupId(group);
          return id && !beforeGroupIds.includes(id) && groupShouldBeAdded(
            upstream,
            group,
            candidate.platform,
            candidate.targetMarginMin,
            candidate.targetMarginMax,
          );
        })
        .map(groupId)
        .filter(Boolean)
      : [];
    if (!removable.length && !addable.length) {
      await this.repository.recordProfitGuardEvaluation(candidate);
      return { changed: false, reason: beforeGroupIds.length ? '' : 'account has no eligible group changes' };
    }
    let afterGroupIds = [...new Set([
      ...beforeGroupIds.filter((id) => !removable.includes(id)),
      ...addable,
    ])];
    if (!candidate.allowEmptyGroups && afterGroupIds.length === 0) {
      for (const id of removable) {
        const group = groupsById.get(id);
        await this.repository.recordProfitGuardEvaluation(candidate, {
          action: 'blocked_last_group',
          groupId: id,
          groupName: groupName(group, id),
          upstreamMultiplier: upstream,
          groupMultiplier: groupMultiplier(group),
          thresholdMode: candidate.thresholdMode,
          minimumSaleMultiplier: candidate.minimumSaleMultiplier,
          beforeGroupIds,
          afterGroupIds: beforeGroupIds,
          reason: `${removalReason({
            groupName: groupName(group, id),
            upstreamMultiplier: upstream,
            groupRateMultiplier: groupMultiplier(group),
            minimumMargin: candidate.minimumMargin,
            thresholdMode: candidate.thresholdMode,
            minimumSaleMultiplier: candidate.minimumSaleMultiplier,
          })}；为避免账号完全失去销售分组，未执行移除`,
        });
      }
      return { changed: false, blocked: true };
    }
    const current = await this.gateway.getAccount(candidate.accountId, { fresh: true });
    const latestGroupIds = [...new Set(groupIdsFromAccount(current))];
    const latestRemovable = latestGroupIds.filter((id) => {
      const group = groupsById.get(id);
      return groupShouldBeRemoved(
        upstream,
        groupMultiplier(group),
        candidate.minimumMargin,
        candidate.thresholdMode,
        candidate.minimumSaleMultiplier,
      );
    });
    const latestAddable = autoAssign
      ? [...groupsById.values()]
        .filter((group) => {
          const id = groupId(group);
          return id && !latestGroupIds.includes(id) && groupShouldBeAdded(
            upstream,
            group,
            candidate.platform,
            candidate.targetMarginMin,
            candidate.targetMarginMax,
          );
        })
        .map(groupId)
        .filter(Boolean)
      : [];
    afterGroupIds = [...new Set([
      ...latestGroupIds.filter((id) => !latestRemovable.includes(id)),
      ...latestAddable,
    ])];
    const changedGroupIds = latestGroupIds.join(',') !== afterGroupIds.join(',');
    if (!changedGroupIds) {
      await this.repository.recordProfitGuardEvaluation(candidate);
      return { changed: false };
    }
    if (!candidate.allowEmptyGroups && afterGroupIds.length === 0) {
      for (const id of latestRemovable) {
        const group = groupsById.get(id);
        await this.repository.recordProfitGuardEvaluation(candidate, {
          action: 'blocked_last_group',
          groupId: id,
          groupName: groupName(group, id),
          upstreamMultiplier: upstream,
          groupMultiplier: groupMultiplier(group),
          thresholdMode: candidate.thresholdMode,
          minimumSaleMultiplier: candidate.minimumSaleMultiplier,
          beforeGroupIds: latestGroupIds,
          afterGroupIds: latestGroupIds,
          reason: `${removalReason({
            groupName: groupName(group, id),
            upstreamMultiplier: upstream,
            groupRateMultiplier: groupMultiplier(group),
            minimumMargin: candidate.minimumMargin,
            thresholdMode: candidate.thresholdMode,
            minimumSaleMultiplier: candidate.minimumSaleMultiplier,
          })}；为避免账号完全失去销售分组，未执行移除`,
        });
      }
      return { changed: false, blocked: true };
    }
    await this.gateway.updateAccountGroups(candidate.accountId, afterGroupIds);
    for (const id of latestRemovable) {
      const group = groupsById.get(id);
      await this.repository.recordProfitGuardEvaluation(candidate, {
        action: 'remove_group',
        groupId: id,
        groupName: groupName(group, id),
        upstreamMultiplier: upstream,
        groupMultiplier: groupMultiplier(group),
        thresholdMode: candidate.thresholdMode,
        minimumSaleMultiplier: candidate.minimumSaleMultiplier,
        beforeGroupIds: latestGroupIds,
        afterGroupIds,
        reason: removalReason({
          groupName: groupName(group, id),
          upstreamMultiplier: upstream,
          groupRateMultiplier: groupMultiplier(group),
          minimumMargin: candidate.minimumMargin,
          thresholdMode: candidate.thresholdMode,
          minimumSaleMultiplier: candidate.minimumSaleMultiplier,
        }),
      });
    }
    for (const id of latestAddable) {
      const group = groupsById.get(id);
      const margin = 1 - upstream / groupMultiplier(group);
      await this.repository.recordProfitGuardEvaluation(candidate, {
        action: 'add_group',
        groupId: id,
        groupName: groupName(group, id),
        upstreamMultiplier: upstream,
        groupMultiplier: groupMultiplier(group),
        thresholdMode: candidate.thresholdMode,
        minimumSaleMultiplier: candidate.minimumSaleMultiplier,
        beforeGroupIds: latestGroupIds,
        afterGroupIds,
        reason: `分组“${groupName(group, id)}”预计毛利率 ${(margin * 100).toFixed(2)}%，位于目标范围 ${(candidate.targetMarginMin * 100).toFixed(2)}%-${(candidate.targetMarginMax * 100).toFixed(2)}%，且平台匹配${candidate.platform}`,
      });
    }
    return {
      changed: true,
      beforeGroupIds: latestGroupIds,
      afterGroupIds,
      removed: latestRemovable,
      added: latestAddable,
    };
  }
}
