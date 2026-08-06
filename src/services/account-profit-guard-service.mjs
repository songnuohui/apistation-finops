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

function removalReason({ upstreamMultiplier, groupRateMultiplier, minimumMargin, thresholdMode, minimumSaleMultiplier }) {
  if (groupRateMultiplier !== null && groupRateMultiplier <= upstreamMultiplier) {
    return `分组售价倍率 ${groupRateMultiplier}x 不高于上游成本倍率 ${upstreamMultiplier}x`;
  }
  if (thresholdMode === 'minimum_sale_multiplier') {
    return `分组售价倍率 ${groupRateMultiplier}x 低于最低售卖倍率 ${minimumSaleMultiplier}x（上游成本倍率 ${upstreamMultiplier}x）`;
  }
  return `上游成本倍率 ${upstreamMultiplier}x 导致预计毛利率低于 ${minimumMargin * 100}%`;
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
    return minimumSaleMultiplier !== null && groupRateMultiplier < minimumSaleMultiplier;
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
    if (!beforeGroupIds.length) {
      await this.repository.recordProfitGuardEvaluation(candidate);
      return { changed: false, reason: 'account has no groups' };
    }
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
    if (!removable.length) {
      await this.repository.recordProfitGuardEvaluation(candidate);
      return { changed: false };
    }
    let afterGroupIds = beforeGroupIds.filter((id) => !removable.includes(id));
    if (!candidate.allowEmptyGroups && afterGroupIds.length === 0) {
      for (const id of removable) {
        const group = groupsById.get(id);
        await this.repository.recordProfitGuardEvaluation(candidate, {
          action: 'blocked_last_group',
          groupId: id,
          groupName: group?.name || '',
          upstreamMultiplier: upstream,
          groupMultiplier: groupMultiplier(group),
          thresholdMode: candidate.thresholdMode,
          minimumSaleMultiplier: candidate.minimumSaleMultiplier,
          beforeGroupIds,
          afterGroupIds: beforeGroupIds,
          reason: `${removalReason({
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
    if (latestGroupIds.join(',') !== beforeGroupIds.join(',')) {
      afterGroupIds = latestGroupIds.filter((id) => !removable.includes(id));
    }
    await this.gateway.updateAccountGroups(candidate.accountId, afterGroupIds);
    for (const id of removable) {
      const group = groupsById.get(id);
      await this.repository.recordProfitGuardEvaluation(candidate, {
        action: 'remove_group',
        groupId: id,
        groupName: group?.name || '',
        upstreamMultiplier: upstream,
        groupMultiplier: groupMultiplier(group),
        thresholdMode: candidate.thresholdMode,
        minimumSaleMultiplier: candidate.minimumSaleMultiplier,
        beforeGroupIds: latestGroupIds,
        afterGroupIds,
        reason: removalReason({
          upstreamMultiplier: upstream,
          groupRateMultiplier: groupMultiplier(group),
          minimumMargin: candidate.minimumMargin,
          thresholdMode: candidate.thresholdMode,
          minimumSaleMultiplier: candidate.minimumSaleMultiplier,
        }),
      });
    }
    return { changed: true, beforeGroupIds: latestGroupIds, afterGroupIds, removed: removable };
  }
}
