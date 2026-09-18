/**
 * Phase 9 — in-process login throttling (RECOMMENDED hardening, approved plan).
 *
 * Exponential backoff per account email AND per client IP around credential
 * verification. Kept deliberately small: capped delay, reset on success,
 * in-memory only (a process restart clears state; brute force is still slowed
 * by the argon2id cost). The user-visible error is unchanged ("Invalid
 * credentials") so throttling never reveals whether an account exists.
 *
 * `now()` is injectable for deterministic tests.
 */

const MAX_DELAY_MS = 15_000;

interface AttemptState {
  count: number;
  nextAttemptAt: number;
}

const byAccount = new Map<string, AttemptState>();
const byIp = new Map<string, AttemptState>();
/** Test hook: replaces the clock. */
let nowFn: () => number = () => Date.now();

export function setThrottleClock(fn: () => number): void {
  nowFn = fn;
}

function bucket(store: Map<string, AttemptState>, key: string): AttemptState | undefined {
  return store.get(key);
}

function punish(store: Map<string, AttemptState>, key: string, at: number): void {
  const prev = store.get(key);
  const count = (prev?.count ?? 0) + 1;
  // Exponential backoff: 0.5s, 1s, 2s, 4s ... capped at MAX_DELAY_MS.
  const delay = Math.min(MAX_DELAY_MS, 500 * 2 ** (count - 1));
  store.set(key, { count, nextAttemptAt: at + delay });
}

function clear(store: Map<string, AttemptState>, key: string): void {
  store.delete(key);
}

function delayFor(store: Map<string, AttemptState>, key: string, at: number): number {
  const state = store.get(key);
  if (!state) return 0;
  return Math.max(0, state.nextAttemptAt - at);
}

function prune(store: Map<string, AttemptState>, at: number): void {
  // Entries older than 10 minutes since their next attempt are irrelevant.
  for (const [key, state] of store) {
    if (state.nextAttemptAt < at - 10 * 60 * 1000) store.delete(key);
  }
}

export interface ThrottleVerdict {
  allowed: boolean;
  retryAfterMs: number;
}

/** Check BEFORE verifying credentials; reject early while backed off. */
export function loginThrottleCheck(accountKey: string, ipKey: string): ThrottleVerdict {
  const at = nowFn();
  prune(byAccount, at);
  prune(byIp, at);
  const dAccount = delayFor(byAccount, accountKey, at);
  const dIp = delayFor(byIp, ipKey, at);
  const retryAfterMs = Math.max(dAccount, dIp);
  return { allowed: retryAfterMs === 0, retryAfterMs };
}

/** Record a FAILED credential attempt for both scopes. */
export function loginThrottleRecordFailure(accountKey: string, ipKey: string): void {
  const at = nowFn();
  punish(byAccount, accountKey, at);
  punish(byIp, ipKey, at);
}

/** Clear both scopes after a successful login. */
export function loginThrottleRecordSuccess(accountKey: string, ipKey: string): void {
  clear(byAccount, accountKey);
  clear(byIp, ipKey);
}
