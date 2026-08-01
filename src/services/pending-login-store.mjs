import crypto from 'node:crypto';

export class PendingLoginStore {
  constructor({ ttlSeconds = 300, now = () => Date.now() } = {}) {
    this.ttlMs = ttlSeconds * 1000;
    this.now = now;
    this.items = new Map();
  }

  create(tempToken) {
    this.prune();
    const id = crypto.randomBytes(32).toString('base64url');
    this.items.set(id, { tempToken, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  get(id) {
    this.prune();
    return this.items.get(id) || null;
  }

  delete(id) {
    this.items.delete(id);
  }

  prune() {
    const now = this.now();
    for (const [id, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(id);
    }
  }
}
