import { signOrigin, readServerReceipt } from './origin-security';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LocationService } from './location.service';
import { latestLocation } from './location-policy';
import { NetworkService } from './network.service';
import { SOSApiService, ApiError } from './sos-api.service';
import { BLEMeshService } from './ble-mesh.service';
import { SOSPayload, SOSType, SOSStatus, DeliveryMethod, SOSMessageType, SOSCancellation, SOSLocation, SOSResponse } from '../interfaces/sos.types';
import { isLivePayload } from './ble-codec';
import { SOS_TTL_SECONDS, MAX_HOP_COUNT } from '../constants/ble.constants';
import { recordSaved, recordReceipt, recordDeliveryError } from './delivery.service';
import { mayUpload, uploadFailed, uploadSucceeded } from './retry-policy';

const ACTIVE_KEY = '@suraksha.active.v2';
const CANCEL_PACKETS = '@suraksha.cancel.packets.v2';
const QUEUE_KEY = '@suraksha_sos_queue';
const CANCEL_KEY = '@suraksha_sos_cancellations';
const DEVICE_KEY = '@suraksha_device_id';
export const bleMeshInstance = new BLEMeshService();

export class SOSTriggerService {
  // Only local read/modify/write work belongs in this lock. Never await radio,
  // GPS, permission prompts, or HTTP while holding it.
  private static operations: Promise<unknown> = Promise.resolve();
  private static exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(action, action); this.operations = next.catch(() => undefined); return next;
  }
  private static async read<T>(key: string): Promise<T[]> {
    const parsed: unknown = JSON.parse(await AsyncStorage.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) throw new Error('Stored SOS queue is invalid; it has been preserved.');
    return parsed as T[];
  }
  private static deviceIdPromise: Promise<string> | undefined;
  public static getDeviceId(): Promise<string> {
    return this.deviceIdPromise ??= (async () => {
      let id = await AsyncStorage.getItem(DEVICE_KEY);
      if (!id) { id = Crypto.randomUUID(); await AsyncStorage.setItem(DEVICE_KEY, id); }
      return id;
    })().catch(error => { this.deviceIdPromise = undefined; throw error; });
  }
  private static broadcast(payload: SOSPayload) {
    void bleMeshInstance.startAdvertising(payload).catch(() => undefined);
  }
  public static async triggerSOS(params: { userId: string; userName: string; userPhone: string;
    authToken?: string; sosType: SOSType; message?: string }): Promise<SOSPayload> {
    if (!params.userId.trim() || !params.userName.trim()) throw new Error('Sign in before sending an SOS.');
    if (params.authToken) SOSApiService.setAuthToken(params.authToken);
    const timestamp = new Date().toISOString();
    const payload: SOSPayload = { protocolVersion: 3, revision: 0, sosId: Crypto.randomUUID(),
      userId: params.userId.trim(), userName: params.userName.trim(), userPhone: params.userPhone.trim(),
      sosType: params.sosType, messageType: SOSMessageType.SOS_ALERT,
      location: LocationService.availableLocation(), timestamp, createdAt: timestamp,
      originDeviceId: await this.getDeviceId(), hopCount: 0, maxHops: MAX_HOP_COUNT, relayChain: [],
      deliveryMethod: DeliveryMethod.OFFLINE_QUEUED, status: SOSStatus.ACTIVE,
      message: params.message, ttlSeconds: SOS_TTL_SECONDS };
    // Enrollment is done at sign-in. A network-dependent renewal must not delay SOS.
    payload.originProof = await signOrigin(payload, false);
    await this.exclusive(async () => {
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify([...active, payload]));
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...queue, payload]));
    });
    await recordSaved(payload);
    void bleMeshInstance.requestPermissions(true).then(() => this.broadcast(payload)).catch(() => undefined);
    void this.retryPendingQueue().catch(() => undefined);
    // Sending and fresh GPS run independently. Failure to get a fix never delays
    // the first packet; a successful fix produces a signed higher revision.
    void this.updateActiveLocations(undefined, true).catch(() => undefined);
    return payload;
  }
  public static async cancelSOS(sosId: string, userId: string, reason?: string, authToken?: string): Promise<boolean> {
    if (authToken) SOSApiService.setAuthToken(authToken);
    const cancellation: SOSCancellation = { sosId, userId, reason, cancelledAt: new Date().toISOString() };
    let packet: SOSPayload | undefined;
    let signingError: string | undefined;
    await this.exclusive(async () => {
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const source = active.find(item => item.sosId === sosId && item.userId === userId);
      if (source) {
        packet = { ...source, protocolVersion: 3, revision: (source.revision ?? 0) + 1,
          messageType: SOSMessageType.SOS_CANCEL, status: SOSStatus.CANCELLED,
          timestamp: cancellation.cancelledAt, location: null, helperRequested: false,
          helperState: source.helperRequestId ? 'withdrawn' : undefined,
          message: reason, hopCount: 0, relayChain: [], originProof: undefined };
        try { packet.originProof = await signOrigin(packet, false); }
        catch { signingError = 'Cancelled locally. Bluetooth proof unavailable; reconnect to synchronize cancellation.'; }
        const packets = await this.read<SOSPayload>(CANCEL_PACKETS);
        await AsyncStorage.setItem(CANCEL_PACKETS, JSON.stringify([...packets.filter(p => p.sosId !== sosId), packet]));
      }
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.filter(item => item.sosId !== sosId)));
      const pending = await this.read<SOSCancellation>(CANCEL_KEY);
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify([...pending.filter(item => item.sosId !== sosId), cancellation]));
      await this.remove(sosId);
    });
    if (packet) {
      await recordSaved(packet);
      if (packet.originProof) this.broadcast(packet);
      else {
        void bleMeshInstance.retireSOS(sosId).catch(() => undefined);
        await recordDeliveryError(packet, signingError!);
      }
    }
    void this.retryPendingQueue().catch(() => undefined);
    return false; // UI watches durable delivery state for later confirmation.
  }
  public static async activeSOS(): Promise<SOSPayload[]> {
    const cancelled = await this.read<SOSPayload>(CANCEL_PACKETS);
    return (await this.read<SOSPayload>(ACTIVE_KEY)).filter(p => isLivePayload(p) && !cancelled.some(c => c.sosId === p.sosId));
  }
  public static async requestHelper(sosId: string, withdraw = false): Promise<void> {
    let next: SOSPayload | undefined;
    await this.exclusive(async () => {
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const item = active.find(p => p.sosId === sosId && isLivePayload(p));
      if (!item) throw new Error('SOS is no longer active');
      next = { ...item, protocolVersion: 3, revision: (item.revision ?? 0) + 1,
        helperRequested: !withdraw, helperState: withdraw ? 'withdrawn' : 'pending',
        helperRequestId: withdraw ? item.helperRequestId : Crypto.randomUUID(),
        helperRequestExpiresAt: withdraw ? item.helperRequestExpiresAt : new Date(Date.now() + 300000).toISOString(),
        hopCount: 0, relayChain: [] };
      next.originProof = await signOrigin(next, false);
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.map(p => p.sosId === sosId ? next : p)));
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...queue.filter(p => p.sosId !== sosId), next]));
    });
    if (next) { await recordSaved(next); this.broadcast(next); }
    void this.retryPendingQueue().catch(() => undefined);
  }
  private static updating: Promise<void> | undefined;
  public static updateActiveLocations(fix?: SOSLocation, force = false): Promise<void> {
    // An OS background fix arriving during a foreground lookup must not be lost.
    if (fix && this.updating) return this.updating.then(() => this.updateActiveLocations(fix, force));
    return this.updating ??= this.refreshLocations(fix, force).finally(() => { this.updating = undefined; });
  }
  private static async refreshLocations(fix?: SOSLocation, force = false): Promise<void> {
    const due = (await this.activeSOS()).filter(p => force || Date.now() - Date.parse(p.timestamp) >= 60000);
    if (!due.length) return;
    const location = fix ?? await LocationService.getCurrentLocation(false).catch(() => null);
    for (const old of due) {
      let next: SOSPayload | undefined;
      await this.exclusive(async () => {
        const active = await this.read<SOSPayload>(ACTIVE_KEY);
        const current = active.find(p => p.sosId === old.sosId);
        if (!current || !isLivePayload(current) || (await this.read<SOSPayload>(CANCEL_PACKETS)).some(p => p.sosId === current.sosId)) return;
        next = { ...current, protocolVersion: 3, revision: (current.revision ?? 0) + 1,
          timestamp: new Date().toISOString(), location: latestLocation(current.location, location), hopCount: 0, relayChain: [] };
        next.originProof = await signOrigin(next, false);
        await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.map(p => p.sosId === next!.sosId ? next : p)));
        const queue = await this.read<SOSPayload>(QUEUE_KEY);
        await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...queue.filter(p => p.sosId !== next!.sosId), next]));
      });
      if (next) { await recordSaved(next); this.broadcast(next); }
    }
  }
  public static async acceptReceipt(receipt: SOSPayload): Promise<void> {
    await recordReceipt(receipt);
    if (receipt.receiptKind !== 'server' || receipt.receiptStatus !== 'cancelled' || receipt.targetDeviceId !== await this.getDeviceId()) return;
    await this.exclusive(async () => {
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify((await this.read<SOSPayload>(ACTIVE_KEY)).filter(p => p.sosId !== receipt.targetSosId)));
      await this.remove(receipt.targetSosId!);
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify((await this.read<SOSCancellation>(CANCEL_KEY)).filter(p => p.sosId !== receipt.targetSosId)));
    });
    // Keep our signed cancellation on air; stop only an obsolete alert.
    if (!(await this.read<SOSPayload>(CANCEL_PACKETS)).some(p => p.sosId === receipt.targetSosId))
      void bleMeshInstance.retireSOS(receipt.targetSosId!).catch(() => undefined);
  }
  private static async accepted(payload: SOSPayload, response: SOSResponse) {
    await uploadSucceeded(payload);
    if (response.receipt) await this.acceptReceipt(await readServerReceipt(response.receipt));
  }
  private static retrying: Promise<void> | undefined;
  public static retryPendingQueue(): Promise<void> {
    return this.retrying ??= this.flushQueue().finally(() => { this.retrying = undefined; });
  }
  private static async flushQueue(): Promise<void> {
    // Recover partial cancellation writes before any HTTP attempt.
    const packets = await this.exclusive(async () => {
      const packets = await this.read<SOSPayload>(CANCEL_PACKETS);
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      const pending = await this.read<SOSCancellation>(CANCEL_KEY);
      for (const packet of packets) {
        if ([...active, ...queue].some(p => p.sosId === packet.sosId) && !pending.some(p => p.sosId === packet.sosId))
          pending.push({ sosId: packet.sosId, userId: packet.userId, cancelledAt: packet.timestamp, reason: packet.message });
        await this.remove(packet.sosId);
      }
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(pending));
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.filter(p => !packets.some(c => c.sosId === p.sosId))));
      // Retain expired controls until their HTTP cancellation has been confirmed.
      await AsyncStorage.setItem(CANCEL_PACKETS, JSON.stringify(packets.filter(p => isLivePayload(p) || pending.some(c => c.sosId === p.sosId))));
      return packets;
    });
    // An expired/missing certificate must not prevent local cancellation. Retry
    // signing the durable draft after normal device enrollment recovers.
    for (const packet of packets.filter(isLivePayload)) {
      if (!packet.originProof) {
        try {
          packet.originProof = await signOrigin(packet, false);
          await this.exclusive(async () => {
            const latest = await this.read<SOSPayload>(CANCEL_PACKETS);
            await AsyncStorage.setItem(CANCEL_PACKETS, JSON.stringify(latest.map(p => p.sosId === packet.sosId && p.revision === packet.revision ? packet : p)));
          });
        } catch { continue; }
      }
      this.broadcast(packet);
    }
    const cancellations = await this.exclusive(() => this.read<SOSCancellation>(CANCEL_KEY));
    const queue = await this.exclusive(() => this.read<SOSPayload>(QUEUE_KEY));
    if (!cancellations.length && !queue.length) return;
    const { isOnline } = await NetworkService.checkConnectivity().catch(() => ({ isOnline: false }));
    for (const cancellation of cancellations) {
      const packet = packets.find(p => p.sosId === cancellation.sosId);
      if (!isOnline || (packet && !await mayUpload(packet))) continue;
      try {
        const response = packet?.originProof && isLivePayload(packet) ? await SOSApiService.sendSOS(packet) : await SOSApiService.cancelSOS(cancellation);
        if (packet) {
          await this.accepted(packet, response);
          if (!response.receipt) await recordReceipt({ ...packet, targetSosId: packet.sosId, targetDeviceId: packet.originDeviceId,
            receiptKind: 'server', receiptMessageType: SOSMessageType.SOS_CANCEL, receiptStatus: 'cancelled' });
        }
        await this.exclusive(async () => {
          await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify((await this.read<SOSCancellation>(CANCEL_KEY)).filter(p => p.sosId !== cancellation.sosId)));
        });
      } catch (error) { if (packet) { await uploadFailed(packet, error); await recordDeliveryError(packet, error instanceof Error ? error.message : 'Cancellation awaiting retry'); } }
    }
    for (const payload of queue) {
      const present = await this.exclusive(async () => (await this.read<SOSPayload>(QUEUE_KEY)).some(p => p.sosId === payload.sosId && p.revision === payload.revision) &&
        !(await this.read<SOSPayload>(CANCEL_PACKETS)).some(p => p.sosId === payload.sosId));
      if (!present) continue;
      if (!isLivePayload(payload)) { await this.exclusive(() => this.remove(payload.sosId, payload.revision ?? 0)); continue; }
      this.broadcast(payload);
      if (!isOnline || !await mayUpload(payload)) continue;
      try {
        const response = await SOSApiService.sendSOS({ ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.OFFLINE_QUEUED });
        await this.accepted(payload, response);
        if (!response.receipt) await recordReceipt({ ...payload, targetSosId: payload.sosId, targetDeviceId: payload.originDeviceId,
          receiptKind: 'server', receiptRevision: payload.revision ?? 0, receiptMessageType: SOSMessageType.SOS_ALERT, receiptStatus: 'accepted' });
        await this.exclusive(() => this.remove(payload.sosId, payload.revision ?? 0));
      } catch (error) {
        if (error instanceof ApiError && error.status === 410) {
          if (error.receipt) await this.acceptReceipt(await readServerReceipt(error.receipt));
          await this.exclusive(async () => {
            await this.remove(payload.sosId);
            await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify((await this.read<SOSPayload>(ACTIVE_KEY)).filter(p => p.sosId !== payload.sosId)));
          });
          void bleMeshInstance.retireSOS(payload.sosId).catch(() => undefined);
        } else { await uploadFailed(payload, error); await recordDeliveryError(payload, error instanceof Error ? error.message : 'Delivery awaiting retry'); }
      }
    }
  }
  private static async remove(sosId: string, revision?: number): Promise<void> {
    const queue = await this.read<SOSPayload>(QUEUE_KEY);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.filter(p => p.sosId !== sosId || (revision !== undefined && (p.revision ?? 0) > revision)).map(p => ({ ...p, authToken: undefined }))));
  }
}
