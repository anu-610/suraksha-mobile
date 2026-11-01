import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOSPayload } from '../interfaces/sos.types';
import { packetKey } from './mesh-policy';
const KEY = '@suraksha.retry.v3';
type Attempt = { count: number; after: number; permanent?: boolean; until: number };
type RetryState = { cooldown: number; attempts: Record<string, Attempt> };
let lock: Promise<unknown> = Promise.resolve();
async function update<T>(work: (state: RetryState) => T): Promise<T> {
  const next = lock.then(async () => {
    const state: RetryState = JSON.parse(await AsyncStorage.getItem(KEY) ?? '{"cooldown":0,"attempts":{}}');
    for (const [key, attempt] of Object.entries(state.attempts)) if (attempt.until <= Date.now()) delete state.attempts[key];
    const result = work(state); await AsyncStorage.setItem(KEY, JSON.stringify(state)); return result;
  }); lock = next.catch(() => undefined); return next;
}
export const mayUpload = (p: SOSPayload) => update(state => !state.attempts[packetKey(p)]?.permanent &&
  Date.now() >= Math.max(p.messageType === 'SOS_CANCEL' ? 0 : state.cooldown, state.attempts[packetKey(p)]?.after ?? 0));
export const uploadSucceeded = (p: SOSPayload) => update(state => { delete state.attempts[packetKey(p)]; });
export const uploadFailed = (p: SOSPayload, error: unknown) => update(state => {
  const value = error as { status?: number; retryAfterMs?: number };
  const count = (state.attempts[packetKey(p)]?.count ?? 0) + 1;
  const delay = value.retryAfterMs ?? Math.min(300000, 5000 * 2 ** Math.min(6, count - 1)) + Math.random() * 1000;
  const after = Date.now() + delay;
  if (value.status === 429 || value.status === 503) state.cooldown = Math.max(state.cooldown, after);
  state.attempts[packetKey(p)] = { count, after, permanent: [403, 409, 422].includes(value.status ?? 0),
    until: Date.parse(p.timestamp) + p.ttlSeconds * 1000 };
});
