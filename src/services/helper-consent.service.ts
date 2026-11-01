import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { SOSPayload, SOSMessageType, SOSStatus, DeliveryMethod } from '../interfaces/sos.types';
import { KEYS, serial, list, enqueue, Tombstone } from './mesh-store';
import { requestId, requestExpiry, requestIsOpen, expiresAt } from './mesh-policy';
import { signOrigin } from './origin-security';
import { SOSTriggerService, bleMeshInstance } from './sos-trigger.service';
import { SOSApiService } from './sos-api.service';
import { NetworkService } from './network.service';
import { LocationService } from './location.service';
import { loadSession } from './session.service';
import { queueServerReceipt } from './mesh-receipts';

export interface HelperChoice {
  key: string; requestId: string; sosId: string; userId: string; operation: string; until: number;
  state: 'preparing' | 'accepted' | 'declined' | 'withdrawn' | 'error'; packet?: SOSPayload; error?: string;
}
export async function helperChoices(userId: string): Promise<HelperChoice[]> {
  return (await list<HelperChoice>(KEYS.outgoing)).filter(p => p.userId === userId && p.until + 3600000 > Date.now());
}
async function saveChoice(choice: HelperChoice) {
  const rows = (await list<HelperChoice>(KEYS.outgoing)).filter(p => p.key !== choice.key && p.until + 3600000 > Date.now());
  await AsyncStorage.setItem(KEYS.outgoing, JSON.stringify([...rows, choice].slice(-100)));
}
async function checkRequest(event: SOSPayload) {
  const current = (await list<SOSPayload>(KEYS.nearby)).find(p => p.sosId === event.sosId);
  const cancelled = (await list<Tombstone>(KEYS.tombstones)).some(p => p.id === event.sosId && p.owner === event.userId && p.until > Date.now());
  if (cancelled || !current || !requestIsOpen(current) || requestId(current) !== requestId(event)) throw new Error('This permission request has expired or was withdrawn.');
}
export async function respondToHelper(event: SOSPayload, action: 'accepted' | 'declined' | 'withdrawn'): Promise<void> {
  const session = await loadSession();
  if (!session) throw new Error('Sign in before responding.');
  const deviceId = await SOSTriggerService.getDeviceId();
  const key = `${event.sosId}:${requestId(event)}:${deviceId}`;
  const operation = Crypto.randomUUID();
  let choice!: HelperChoice;
  await serial(async () => {
    if (action !== 'withdrawn') await checkRequest(event);
    const previous = (await list<HelperChoice>(KEYS.outgoing)).find(p => p.key === key);
    if (action === 'accepted' && previous?.state === 'preparing') throw new Error('GPS is already being acquired.');
    if (action === 'accepted' && previous?.state === 'withdrawn') throw new Error('Wait for a new permission request after withdrawing.');
    choice = { ...previous, key, requestId: requestId(event), sosId: event.sosId, userId: session.user.user_id,
      operation, until: requestExpiry(event), state: action === 'accepted' ? 'preparing' : action, error: undefined };
    await saveChoice(choice);
  });
  try {
    let location: SOSPayload['location'] = null;
    if (action === 'accepted') {
      if (!(await NetworkService.checkConnectivity()).isOnline) throw new Error('Connect to the backend before offering an online meeting point.');
      const response = await SOSApiService.sendSOS(bleMeshInstance.prepareRelay(event, deviceId));
      if (response.receipt) await queueServerReceipt(response.receipt);
      location = await LocationService.getCurrentLocation();
      if (location.provider === 'last_known' || !location.capturedAt || Date.now() - Date.parse(location.capturedAt) > 120000)
        throw new Error('No fresh GPS fix. Move to an open area and try again.');
    }
    const timestamp = new Date().toISOString();
    const packet: SOSPayload = { protocolVersion: 3, revision: (choice.packet?.revision ?? -1) + 1,
      sosId: choice.packet?.sosId ?? Crypto.randomUUID(), messageType: SOSMessageType.SOS_HELPER,
      userId: session.user.user_id, userName: session.user.name, userPhone: '', sosType: event.sosType,
      originDeviceId: deviceId, timestamp, createdAt: choice.packet?.createdAt ?? timestamp,
      targetSosId: event.sosId, targetDeviceId: event.originDeviceId, helperRequested: false,
      helperRequestId: requestId(event), helperRequestExpiresAt: new Date(requestExpiry(event)).toISOString(), helperState: action,
      location, ttlSeconds: action === 'withdrawn' ? 300 : Math.max(1, Math.min(300, Math.floor((requestExpiry(event) - Date.now()) / 1000))),
      hopCount: 0, maxHops: 15, relayChain: [], status: SOSStatus.ACTIVE, deliveryMethod: DeliveryMethod.BLE_RELAY };
    packet.originProof = await signOrigin(packet, false);
    await serial(async () => {
      const current = (await list<HelperChoice>(KEYS.outgoing)).find(p => p.key === key);
      if (current?.operation !== operation) throw new Error('Your earlier sharing choice was changed.');
      if (action !== 'withdrawn') await checkRequest(event); // GPS/HTTP may have taken time.
      await enqueue(packet);
      await saveChoice({ ...choice, packet, state: action });
    });
    void bleMeshInstance.startAdvertising(packet).catch(() => undefined);
  } catch (error) {
    await serial(async () => {
      if ((await list<HelperChoice>(KEYS.outgoing)).find(p => p.key === key)?.operation === operation)
        await saveChoice({ ...choice, state: 'error', error: error instanceof Error ? error.message : 'Unable to share' });
    });
    throw error;
  }
}
export const shareHelperLocation = (event: SOSPayload) => respondToHelper(event, 'accepted');
export function helperResponseState(packet: SOSPayload): string {
  if (packet.helperState === 'withdrawn') return 'withdrawn';
  if (expiresAt(packet) <= Date.now() || requestExpiry(packet) <= Date.now()) return 'expired';
  return packet.helperState ?? 'accepted';
}
