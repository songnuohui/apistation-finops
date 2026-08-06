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

export function groupShouldBeRemoved(upstreamMultiplier, groupRateMultiplier, minimumMargin) {
  if (upstreamMultiplier === null || groupRateMultiplier === null || groupRateMultiplier <= 0) return false;
  const margin = 1 - upstreamMultiplier / groupRateMultiplier;
  return groupRateMultiplier <= upstreamMultiplier || margin < minimumMargin;
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
      return groupShouldBeRemoved(upstream, groupMultiplier(group), candidate.minimumMargin);
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
          beforeGroupIds,
          afterGroupIds: beforeGroupIds,
          reason: `上游成本倍率 ${upstream}x 已不满足分组 ${group?.name || id} 的最低毛利率 ${candidate.minimumMargin * 100}%；为避免账号完全失去销售分组，未执行移除`,
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
        beforeGroupIds: latestGroupIds,
        afterGroupIds,
        reason: `上游成本倍率 ${upstream}x 导致预计毛利率低于 ${candidate.minimumMargin * 100}%`,
      });
    }
    return { changed: true, beforeGroupIds: latestGroupIds, afterGroupIds, removed: removable };
  }
}
