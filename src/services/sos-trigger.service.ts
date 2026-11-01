import { signOrigin } from './origin-security';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LocationService } from './location.service';
import { NetworkService } from './network.service';
import { SOSApiService, ApiError } from './sos-api.service';
import { BLEMeshService } from './ble-mesh.service';
import { SOSPayload, SOSType, SOSStatus, DeliveryMethod, SOSMessageType, SOSCancellation, SOSLocation } from '../interfaces/sos.types';
import { isLivePayload } from './ble-codec';
import { SOS_TTL_SECONDS, MAX_HOP_COUNT } from '../constants/ble.constants';

const ACTIVE_KEY = '@suraksha.active.v2';
const CANCEL_PACKETS = '@suraksha.cancel.packets.v2';
const QUEUE_KEY = '@suraksha_sos_queue';
const CANCEL_KEY = '@suraksha_sos_cancellations';
const DEVICE_KEY = '@suraksha_device_id';
export const bleMeshInstance = new BLEMeshService();

function uuid(): string { return Crypto.randomUUID(); }

export class SOSTriggerService {
  // Serialize read-modify-write operations and network retries to prevent lost updates.
  private static operations: Promise<unknown> = Promise.resolve();
  private static exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(action, action);
    this.operations = next.catch(() => undefined);
    return next;
  }
  private static async read<T>(key: string): Promise<T[]> {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Stored SOS queue is invalid; it has been preserved.');
    return parsed as T[];
  }
  private static deviceIdPromise: Promise<string> | undefined;
  public static getDeviceId(): Promise<string> {
    if (this.deviceIdPromise) return this.deviceIdPromise;
    this.deviceIdPromise = (async () => {
      let id = await AsyncStorage.getItem(DEVICE_KEY);
      if (!id) { id = uuid(); await AsyncStorage.setItem(DEVICE_KEY, id); }
      return id;
    })().catch(error => { this.deviceIdPromise = undefined; throw error; });
    return this.deviceIdPromise;
  }
  public static async triggerSOS(params: { userId: string; userName: string; userPhone: string;
    authToken?: string; sosType: SOSType; message?: string }): Promise<SOSPayload> {
    if (!params.userId.trim() || !params.userName.trim()) throw new Error('Enter your user ID and name before sending an SOS.');
    if (params.authToken) SOSApiService.setAuthToken(params.authToken);
    // GPS works offline; a failed fix must never prevent an emergency alert.
    const { isOnline } = await NetworkService.checkConnectivity().catch(() => ({ isOnline: false }));
    const location = await LocationService.getCurrentLocation().catch(() => null);
    const originDeviceId = await this.getDeviceId();
    const timestamp = new Date().toISOString();
    const payload: SOSPayload = { protocolVersion: 2, revision: 0, sosId: uuid(), userId: params.userId.trim(), userName: params.userName.trim(),
      userPhone: params.userPhone.trim(), sosType: params.sosType, messageType: SOSMessageType.SOS_ALERT,
      location, timestamp, createdAt: timestamp, originDeviceId, hopCount: 0, maxHops: MAX_HOP_COUNT,
      relayChain: [], deliveryMethod: DeliveryMethod.OFFLINE_QUEUED, status: SOSStatus.ACTIVE,
      message: params.message, ttlSeconds: SOS_TTL_SECONDS };
    payload.originProof = await signOrigin(payload, isOnline);
    await this.exclusive(async () => {
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      queue.push(payload);
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify([...active, payload]));
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    });
      // Start local discovery immediately, including when the backend is online.
      // Upload success does not retract the nearby alert; cancellation/TTL does.
      let broadcasting = false;
      try {
        await bleMeshInstance.requestPermissions(true);
        await bleMeshInstance.startAdvertising({ ...payload, deliveryMethod: DeliveryMethod.BLE_RELAY });
        broadcasting = true;
      } catch { /* Online delivery still works without Bluetooth. */ }
      try {
        if (isOnline) {
          await SOSApiService.sendSOS({ ...payload, deliveryMethod: DeliveryMethod.DIRECT_ONLINE });
          await this.exclusive(() => this.remove(payload.sosId, payload.revision ?? 0));
          return { ...payload, deliveryMethod: DeliveryMethod.DIRECT_ONLINE };
        }
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          // Stop this advert if the server explicitly rejects the submission.
          await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
          throw new Error(`${error.message}. Alert retained locally for retry after correction.`);
        }
      }
      return broadcasting ? { ...payload, deliveryMethod: DeliveryMethod.BLE_RELAY } : payload;

  }
  public static async cancelSOS(sosId: string, userId: string, reason?: string, authToken?: string): Promise<boolean> {
    if (authToken) SOSApiService.setAuthToken(authToken);
    const cancellation: SOSCancellation = { sosId, userId, reason, cancelledAt: new Date().toISOString() };
    await this.exclusive(async () => {
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const source = active.find(item => item.sosId === sosId && item.userId === userId);
      if (source) {
        const packet: SOSPayload = { ...source, protocolVersion: 2, revision: (source.revision ?? 0) + 1,
          messageType: SOSMessageType.SOS_CANCEL, status: SOSStatus.CANCELLED,
          timestamp: cancellation.cancelledAt, location: null, helperRequested: false,
          message: reason, hopCount: 0, relayChain: [] };
        packet.originProof = await signOrigin(packet, false);
        const packets = await this.read<SOSPayload>(CANCEL_PACKETS);
        await AsyncStorage.setItem(CANCEL_PACKETS, JSON.stringify([...packets.filter(p => p.sosId !== sosId), packet]));
      }
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.filter(item => item.sosId !== sosId)));
      const pending = await this.read<SOSCancellation>(CANCEL_KEY);
      // Persist first. Queue uploads check this tombstone before every send.
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify([...pending.filter(item => item.sosId !== sosId), cancellation]));
      await this.remove(sosId);
    });
    // Local cancellation is durable. Radio and HTTP completion must not hold the UI.
    void this.broadcastCancellations().catch(() => undefined);
    void this.retryPendingQueue().catch(() => undefined);
    return false; // Server confirmation is pending, never imply BLE delivery was acknowledged.
  }
  public static async activeSOS(): Promise<SOSPayload[]> {
    const cancelled = await this.read<SOSPayload>(CANCEL_PACKETS);
    return (await this.read<SOSPayload>(ACTIVE_KEY)).filter(p => isLivePayload(p) && !cancelled.some(c => c.sosId === p.sosId));
  }
  public static async requestHelper(sosId: string): Promise<void> {
    await this.exclusive(async () => {
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const item = active.find(p => p.sosId === sosId && isLivePayload(p));
      if (!item) throw new Error('SOS is no longer active');
      const next: SOSPayload = { ...item, helperRequested: true, protocolVersion: 2,
        revision: (item.revision ?? 0) + 1, hopCount: 0, relayChain: [] };
      next.originProof = await signOrigin(next, false);
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.map(p => p.sosId === sosId ? next : p)));
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...queue.filter(p => p.sosId !== sosId), next]));
    });
    // Requesting permission does not need a new GPS fix or an HTTP round trip.
    const source = (await this.activeSOS()).find(p => p.sosId === sosId);
    if (source) await bleMeshInstance.startAdvertising(source);
  }
  private static updating: Promise<void> | undefined;
  public static updateActiveLocations(fix?: SOSLocation, force = false): Promise<void> {
    if (!this.updating) this.updating = this.refreshLocations(fix, force).finally(() => { this.updating = undefined; });
    return this.updating;
  }
  private static async refreshLocations(fix?: SOSLocation, force = false): Promise<void> {
    const due = (await this.activeSOS()).filter(p => force || Date.now() - Date.parse(p.timestamp) >= 60000);
    if (!due.length) return;
    const location = fix ?? await LocationService.getCurrentLocation(false).catch(() => null);
    for (const old of due) {
      await this.exclusive(async () => {
        const active = await this.read<SOSPayload>(ACTIVE_KEY);
        const current = active.find(p => p.sosId === old.sosId);
        if (!current || !isLivePayload(current) || (await this.read<SOSPayload>(CANCEL_PACKETS)).some(p => p.sosId === current.sosId)) return; // Cancel may have completed during GPS acquisition.
        const next: SOSPayload = { ...current, protocolVersion: 2, revision: (current.revision ?? 0) + 1,
          timestamp: new Date().toISOString(), location, hopCount: 0, relayChain: [] };
        next.originProof = await signOrigin(next, false);
        await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.map(p => p.sosId === next.sosId ? next : p)));
        const queue = await this.read<SOSPayload>(QUEUE_KEY);
        await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify([...queue.filter(p => p.sosId !== next.sosId), next]));
        await bleMeshInstance.startAdvertising(next).catch(() => undefined);
      });
    }
  }
  private static async broadcastCancellations(): Promise<void> {
    const packets = await this.exclusive(async () => {
      const live = (await this.read<SOSPayload>(CANCEL_PACKETS)).filter(isLivePayload);
      await AsyncStorage.setItem(CANCEL_PACKETS, JSON.stringify(live));
      return live;
    });
    for (const packet of packets) await bleMeshInstance.startAdvertising(packet).catch(() => undefined);
  }
  private static retrying: Promise<void> | undefined;
  public static retryPendingQueue(): Promise<void> {
    if (!this.retrying) this.retrying = this.flushQueue().finally(() => { this.retrying = undefined; });
    return this.retrying;
  }
  private static async flushQueue(): Promise<void> {
    await this.broadcastCancellations();
    const { isOnline } = await NetworkService.checkConnectivity().catch(() => ({ isOnline: false }));
    // A crash after persisting the signed cancel but before pruning the alert must never revive it.
    await this.exclusive(async () => {
      const packets = await this.read<SOSPayload>(CANCEL_PACKETS);
      const active = await this.read<SOSPayload>(ACTIVE_KEY);
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      const pending = await this.read<SOSCancellation>(CANCEL_KEY);
      for (const packet of packets) {
        if ([...active, ...queue].some(p => p.sosId === packet.sosId) && !pending.some(p => p.sosId === packet.sosId))
          pending.push({ sosId: packet.sosId, userId: packet.userId, cancelledAt: packet.timestamp, reason: packet.message });
      }
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(pending));
      await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(active.filter(p => !packets.some(c => c.sosId === p.sosId))));
      for (const packet of packets) await this.remove(packet.sosId);
    });
    const cancellations = await this.exclusive(() => this.read<SOSCancellation>(CANCEL_KEY));
    for (const cancellation of cancellations) {
      await this.exclusive(() => this.remove(cancellation.sosId));
      // Keep the cancellation on air while its API retry is pending.
      if (isOnline) {
        try {
          await SOSApiService.cancelSOS(cancellation);
          await this.exclusive(async () => {
            const latest = await this.read<SOSCancellation>(CANCEL_KEY);
            await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(latest.filter(item => item.sosId !== cancellation.sosId)));
          });
        } catch { /* Keep the durable cancellation. */ }
      }
    }
    await this.broadcastCancellations();
    const queue = await this.exclusive(() => this.read<SOSPayload>(QUEUE_KEY));
    for (const payload of queue) {
      // Re-read, because cancellation can happen while another upload is pending.
      const stillQueued = await this.exclusive(async () =>
        (await this.read<SOSPayload>(QUEUE_KEY)).some(item => item.sosId === payload.sosId && (item.revision ?? 0) === (payload.revision ?? 0)) &&
        !(await this.read<SOSCancellation>(CANCEL_KEY)).some(item => item.sosId === payload.sosId));
      if (!stillQueued) continue;
      if (!isLivePayload(payload)) {
        await this.exclusive(() => this.remove(payload.sosId, payload.revision ?? 0));
        await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
        continue;
      }
      if (isOnline) {
        try {
          await SOSApiService.sendSOS({ ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.OFFLINE_QUEUED });
          await this.exclusive(() => this.remove(payload.sosId, payload.revision ?? 0));
          continue;
        } catch { /* Keep undelivered alerts for the next retry. */ }
      }
      // Serialize the final presence check and advertise against local cancellation.
      await this.exclusive(async () => {
        if ((await this.read<SOSPayload>(QUEUE_KEY)).some(item => item.sosId === payload.sosId && (item.revision ?? 0) === (payload.revision ?? 0)))
          await bleMeshInstance.startAdvertising({ ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.BLE_RELAY }).catch(() => undefined);
      });
    }
  }
  private static async remove(sosId: string, revision?: number): Promise<void> {
    const queue = await this.read<SOSPayload>(QUEUE_KEY);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.filter(item => item.sosId !== sosId || (revision !== undefined && (item.revision ?? 0) > revision)).map(item => ({ ...item, authToken: undefined }))));
  }
}
