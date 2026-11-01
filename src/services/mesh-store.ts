import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOSPayload } from '../interfaces/sos.types';
import { isLivePayload } from './ble-codec';
import { canReplace } from './mesh-policy';

export const KEYS = { tombstones: '@suraksha.mesh.cancelled.v2', offers: '@suraksha.helper.offers.v2',
  relays: '@suraksha.relay.pending.v2', nearby: '@suraksha.nearby.v2', forwarded: '@suraksha.relay.forwarded.v1',
  dismissed: '@suraksha.nearby.dismissed.v1', outgoing: '@suraksha.helper.outgoing.v3', peerReceipts: '@suraksha.peer.receipts.v3' };
let operations: Promise<unknown> = Promise.resolve();
export function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work, work); operations = next.catch(() => undefined); return next;
}
export async function list<T>(key: string): Promise<T[]> {
  const result: unknown = JSON.parse(await AsyncStorage.getItem(key) ?? '[]');
  if (!Array.isArray(result)) throw new Error('Mesh storage is invalid and has been preserved.');
  return result as T[];
}
/** Caller holds serial(). Transport runs only after this write completes. */
export async function enqueue(packet: SOSPayload): Promise<boolean> {
  const pending = (await list<SOSPayload>(KEYS.relays)).filter(isLivePayload);
  if (!canReplace(pending.find(p => p.sosId === packet.sosId), packet)) return false;
  await AsyncStorage.setItem(KEYS.relays, JSON.stringify([...pending.filter(p => p.sosId !== packet.sosId), packet]));
  return true;
}
export type Tombstone = { id: string; owner: string; until: number };
