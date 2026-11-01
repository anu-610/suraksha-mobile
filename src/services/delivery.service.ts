import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOSPayload, SOSMessageType } from '../interfaces/sos.types';

const KEY = '@suraksha.delivery.v3';
export interface DeliveryState {
  sosId: string; userId: string; deviceId: string; updatedAt: number;
  revision: number; cancelled?: boolean; peerRevision?: number; serverRevision?: number;
  until?: number;
  cancellationPeer?: boolean; cancellationServer?: boolean; error?: string;
}
let writing: Promise<unknown> = Promise.resolve();
async function change(work: (states: DeliveryState[]) => void) {
  const next = writing.then(async () => {
    const states: DeliveryState[] = JSON.parse(await AsyncStorage.getItem(KEY) ?? '[]');
    work(states);
    await AsyncStorage.setItem(KEY, JSON.stringify(states.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100)));
  });
  writing = next.catch(() => undefined); return next;
}
export async function deliveryStates(userId: string): Promise<DeliveryState[]> {
  await writing;
  return (JSON.parse(await AsyncStorage.getItem(KEY) ?? '[]') as DeliveryState[]).filter(p => p.userId === userId);
}
export async function recordSaved(payload: SOSPayload) {
  await change(states => {
    let state = states.find(p => p.sosId === payload.sosId && p.deviceId === payload.originDeviceId);
    if (!state) { state = { sosId: payload.sosId, userId: payload.userId, deviceId: payload.originDeviceId, revision: 0, updatedAt: Date.now() }; states.push(state); }
    state.revision = Math.max(state.revision, payload.revision ?? 0);
    state.until = Date.parse(payload.timestamp) + payload.ttlSeconds * 1000;
    state.cancelled ||= payload.messageType === SOSMessageType.SOS_CANCEL;
    state.error = undefined; state.updatedAt = Date.now();
  });
}
/** The caller must verify the signature before recording a receipt. */
export async function recordReceipt(receipt: SOSPayload) {
  await change(states => {
    const state = states.find(p => p.sosId === receipt.targetSosId && p.deviceId === receipt.targetDeviceId);
    if (!state) return;
    if (receipt.receiptMessageType === SOSMessageType.SOS_CANCEL) {
      if (receipt.receiptKind === 'server') { state.cancellationServer = true; state.cancelled = true; }
      else state.cancellationPeer = true;
    } else if (receipt.receiptKind === 'server') state.serverRevision = Math.max(state.serverRevision ?? -1, receipt.receiptRevision ?? 0);
    else state.peerRevision = Math.max(state.peerRevision ?? -1, receipt.receiptRevision ?? 0);
    state.error = undefined; state.updatedAt = Date.now();
  });
}
export async function recordDeliveryError(payload: SOSPayload, error: string) {
  await change(states => { const state = states.find(p => p.sosId === payload.sosId); if (state) { state.error = error; state.updatedAt = Date.now(); } });
}
export function deliveryLabel(state: DeliveryState): string {
  if (state.cancelled) return state.cancellationServer ? 'Cancellation confirmed by server.' : state.cancellationPeer ?
    'Cancellation received by another phone. Server confirmation pending.' : 'Cancellation saved on this phone. Awaiting delivery confirmation.';
  if (state.until && state.until <= Date.now() && state.serverRevision === undefined) return 'SOS expired without server confirmation. Start a new SOS if you still need help.';
  if (state.serverRevision !== undefined) return state.serverRevision >= state.revision ? 'SOS and latest update accepted by server.' : 'SOS accepted by server. Latest update awaiting confirmation.';
  return state.peerRevision !== undefined ? 'SOS received by another phone. Server confirmation pending.' : 'SOS saved on this phone. Awaiting delivery confirmation.';
}
