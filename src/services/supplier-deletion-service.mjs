function accountIdsFromPlan(plan) {
  return [...new Set((plan?.accountIds || [])
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0))];
}

export class SupplierDeletionService {
  constructor(repository, sub2ApiGateway, { demoMode = false, logger = console } = {}) {
    this.repository = repository;
    this.gateway = sub2ApiGateway;
    this.demoMode = demoMode;
    this.logger = logger;
  }

  async deleteConnection(connectionId, actor = 'admin') {
    const plan = await this.repository.getSupplierConnectionDeletionPlan(connectionId);
    const deletedAccounts = await this.deleteAccounts(plan.accountIds);
    const deleted = await this.repository.deleteSupplierConnection(connectionId, actor);
    return { ...deleted, deletedAccounts };
  }

  async deleteKey(keyId, actor = 'admin') {
    const plan = await this.repository.getSupplierKeyDeletionPlan(keyId);
    const deletedAccounts = await this.deleteAccounts(plan.accountIds);
    const deleted = await this.repository.deleteSupplierKey(keyId, actor);
    return { ...deleted, deletedAccounts };
  }

  async deleteAccounts(accountIds) {
    const ids = accountIdsFromPlan({ accountIds });
    if (this.demoMode) return ids.map((accountId) => ({ accountId, status: 'demo' }));
    if (!ids.length) return [];
    if (!this.gateway?.deleteAccount) {
      throw Object.assign(new Error('Sub2API account deletion is not available'), { statusCode: 503 });
    }
    const deleted = [];
    for (const accountId of ids) {
      try {
        await this.gateway.deleteAccount(accountId);
        deleted.push({ accountId, status: 'deleted' });
      } catch (error) {
        // A previous interrupted deletion may already have removed the account.
        // Treat that state as complete so retries can finish local cleanup.
        if (error?.statusCode === 404) {
          deleted.push({ accountId, status: 'already_missing' });
          continue;
        }
        this.logger.warn('[supplier-delete] Sub2API account deletion failed', accountId, error?.message || error);
        throw Object.assign(new Error(`Sub2API account ${accountId} deletion failed: ${error?.message || 'request failed'}`), {
          statusCode: error?.statusCode || 502,
          cause: error,
        });
      }
    }
    return deleted;
  }
}
