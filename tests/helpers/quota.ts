// A storage quota for fake-indexeddb that behaves like Chrome's: a write
// that would take the site past its limit aborts the whole transaction with
// a genuine QuotaExceededError (everything in it rolls back); deletions
// always succeed. navigator.storage.estimate() reports the real usage and a
// padded quota (usage + 10 GiB), as Chrome does.

import { vi } from "vitest";

const realPut = IDBObjectStore.prototype.put;
const realDelete = IDBObjectStore.prototype.delete;
const realClear = IDBObjectStore.prototype.clear;
export const GiB = 1024 ** 3;

function sizeOf(v: unknown, depth = 0): number {
  if (v == null) return 0;
  if (typeof Blob !== "undefined" && v instanceof Blob) return v.size;
  if (typeof v === "string") return v.length;
  if (typeof v !== "object" || depth > 3) return 8;
  let n = 64;
  for (const x of Object.values(v as Record<string, unknown>))
    n += sizeOf(x, depth + 1);
  return n;
}

export interface Quota {
  limit: number;
  usage: () => number;
  // Every store/key size committed so far.
  sizes: Map<string, number>;
  restore: () => void;
}

export function installQuota(limit: number): Quota {
  const committed = new Map<string, number>();
  const pending = new WeakMap<IDBTransaction, [string, number | null][]>();
  const doomed = new WeakSet<IDBTransaction>();
  const usage = () => [...committed.values()].reduce((a, b) => a + b, 0);
  const quota: Quota = {
    limit,
    usage,
    sizes: committed,
    restore: () => {
      IDBObjectStore.prototype.put = realPut;
      IDBObjectStore.prototype.delete = realDelete;
      IDBObjectStore.prototype.clear = realClear;
    },
  };
  // Writes of transactions not yet committed count too, so two concurrent
  // transactions cannot both squeeze into the same free space.
  const live = new Set<IDBTransaction>();
  const track = (tx: IDBTransaction) => {
    let list = pending.get(tx);
    if (!list) {
      list = [];
      pending.set(tx, list);
      live.add(tx);
      tx.addEventListener("complete", () => {
        live.delete(tx);
        for (const [k, n] of list!)
          if (n === null) committed.delete(k);
          else committed.set(k, n);
      });
      tx.addEventListener("abort", () => live.delete(tx));
    }
    return list;
  };
  const projected = (tx: IDBTransaction, key: string, size: number) => {
    const view = new Map(committed);
    for (const t of [...live, tx])
      for (const [k, n] of pending.get(t) ?? [])
        if (n === null) view.delete(k);
        else view.set(k, n);
    view.set(key, size);
    return [...view.values()].reduce((a, b) => a + b, 0);
  };
  IDBObjectStore.prototype.put = function (value: any, key?: any) {
    const k = `${this.name}/${String(key)}`;
    const size = sizeOf(value);
    const request = realPut.call(this, value, key);
    const tx = this.transaction;
    if (projected(tx, k, size) > quota.limit) {
      // Chrome refuses the write when the transaction commits: the whole
      // transaction aborts with a QuotaExceededError.
      if (!doomed.has(tx)) {
        doomed.add(tx);
        queueMicrotask(() => (tx as any)._abort("QuotaExceededError"));
      }
    } else track(tx).push([k, size]);
    return request;
  };
  IDBObjectStore.prototype.delete = function (key: any) {
    track(this.transaction).push([`${this.name}/${String(key)}`, null]);
    return realDelete.call(this, key);
  };
  IDBObjectStore.prototype.clear = function () {
    const list = track(this.transaction);
    for (const k of committed.keys())
      if (k.startsWith(`${this.name}/`)) list.push([k, null]);
    return realClear.call(this);
  };
  vi.stubGlobal("navigator", {
    ...(globalThis.navigator ?? {}),
    storage: {
      estimate: async () => ({ usage: usage(), quota: usage() + 10 * GiB }),
      persisted: async () => false,
      persist: async () => false,
    },
  });
  return quota;
}

// A localStorage for node tests.
export function stubLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  });
  return data;
}

// navigator.locks with ifAvailable, shared like two tabs of one browser.
export function stubLocks() {
  const held = new Set<string>();
  const locks = {
    request: async (
      name: string,
      opts: { ifAvailable?: boolean },
      cb: (lock: unknown) => Promise<unknown>,
    ) => {
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        throw new Error("blocking lock requests are not simulated");
      }
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  vi.stubGlobal("navigator", { ...(globalThis.navigator ?? {}), locks });
  return locks;
}
