import { PermissionsAndroid, Platform } from 'react-native';
import * as Peripheral from '../../modules/ble-peripheral';
import { SOSPayload, SOSLocation, DeliveryMethod } from '../interfaces/sos.types';
import { encodePayload, isLivePayload } from './ble-codec';
import { canReplace } from './mesh-policy';


type Events = { onInboxReady: undefined; onSOSReceived: SOSPayload; onError: Error; onRelayComplete: SOSPayload };

export class BLEMeshService {
  private listeners: { [K in keyof Events]: Set<(value: Events[K]) => void> } = {
    onInboxReady: new Set(), onSOSReceived: new Set(), onError: new Set(), onRelayComplete: new Set(),
  };
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private scanning = false;
  private subscriptions: { remove(): void }[] = [];
  private relayTimers = new Set<ReturnType<typeof setTimeout>>();
  private advertisingId: string | null = null;
  private latest = new Map<string, SOSPayload>();
  private retired = new Map<string, number>();

  public on<K extends keyof Events>(name: K, callback: (value: Events[K]) => void) { this.listeners[name].add(callback); }
  public off<K extends keyof Events>(name: K, callback: (value: Events[K]) => void) { this.listeners[name].delete(callback); }
  private emit<K extends keyof Events>(name: K, value: Events[K]) { this.listeners[name].forEach(callback => callback(value)); }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeNative();
    try { await this.initializing; } finally { this.initializing = null; }
  }

  private async initializeNative() {
    if (Platform.OS === 'web') throw new Error('BLE requires a native development build. Online delivery remains available.');
    if (!(await Peripheral.initialize())) throw new Error('BLE is unavailable. Install a native development build.');
    this.subscriptions = [
      Peripheral.onSOSReceived(() => this.emit('onInboxReady', undefined)),
      Peripheral.onError(event => this.emit('onError', new Error(event.error))),
    ].filter((subscription): subscription is NonNullable<typeof subscription> => subscription !== null);
    this.initialized = true;
  }

  public async startAdvertising(payload: SOSPayload): Promise<void> {
    if (payload.uploadOnly) return;
    const suppressed = () => (this.retired.get(payload.sosId) ?? 0) > Date.now() && payload.messageType !== 'SOS_CANCEL' ||
      payload.messageType === 'SOS_HELPER' && (this.retired.get(payload.targetSosId ?? '') ?? 0) > Date.now();
    if (suppressed()) return;
    const encoded = encodePayload(payload);
    for (const [id, p] of this.latest) if (Date.parse(p.timestamp) + p.ttlSeconds * 1000 + 300000 < Date.now()) this.latest.delete(id);
    if (!canReplace(this.latest.get(payload.sosId), payload)) return;
    this.latest.set(payload.sosId, payload);
    await this.initialize();
    if (this.latest.get(payload.sosId) !== payload || suppressed()) return;
    if (!(await Peripheral.startAdvertising(encoded))) throw new Error('Bluetooth advertising did not start');
    this.advertisingId = payload.sosId;
    // Native transport expires each packet separately. A stale JS timer must
    // never remove a newer cancellation/update with the same SOS ID.
  }
  public async stopAdvertising(sosId?: string): Promise<void> {
    if (sosId) { await Peripheral.removeAdvertisement(sosId); return; }
    if (this.initialized) await Peripheral.stopAdvertising();
    this.advertisingId = null;
  }
  public async retireSOS(sosId: string, replacingWithCancellation = false): Promise<void> {
    for (const [id, until] of this.retired) if (until <= Date.now()) this.retired.delete(id);
    this.retired.set(sosId, Date.now() + 3900000);
    if (!replacingWithCancellation) await Peripheral.removeAdvertisement(sosId);
    for (const p of this.latest.values()) if (p.messageType === 'SOS_HELPER' && p.targetSosId === sosId) await Peripheral.removeAdvertisement(p.sosId);
  }
  public reportReceived(payload: SOSPayload) { this.emit('onSOSReceived', payload); }
  public async requestPermissions(advertiseOnly = false): Promise<void> {
    if (Platform.OS === 'android') {
      const permissions = Number(Platform.Version) >= 31
        ? advertiseOnly
          ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT, PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE]
          : [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE, PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
        : advertiseOnly ? [] : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      const result = await PermissionsAndroid.requestMultiple(permissions);
      if (permissions.some(permission => result[permission] !== PermissionsAndroid.RESULTS.GRANTED)) throw new Error('Nearby relay requires Bluetooth and location permissions.');
    }
  }
  public async startScanning(): Promise<void> {
    if (this.scanning) return;
    await this.initialize();
    if (!(await Peripheral.startScanning())) throw new Error('Bluetooth scanning did not start');
    this.scanning = true;
  }
  public async stopScanning(): Promise<void> {
    if (this.initialized) await Peripheral.stopScanning();
    this.scanning = false;
  }
  public relayPayload(payload: SOSPayload, deviceId: string, location?: SOSLocation): void {
    if (!isLivePayload(payload) || payload.hopCount >= payload.maxHops || payload.originDeviceId === deviceId ||
        payload.relayChain.some(node => node.deviceId === deviceId)) return;
    const relayed = this.prepareRelay(payload, deviceId, location);
    const timer = setTimeout(() => {
      this.relayTimers.delete(timer);
      // Keep a local user's SOS on air instead of replacing it with a stranger's alert.
      if (this.advertisingId) return;
      this.startAdvertising(relayed).then(() => {
        this.emit('onRelayComplete', relayed);
        const stop = setTimeout(() => {
          this.relayTimers.delete(stop);
          void this.stopAdvertising(relayed.sosId).catch(error => this.emit('onError', error));
        }, 10000);
        this.relayTimers.add(stop);
      }).catch(error => this.emit('onError', error));
    }, 50 + Math.random() * 200);
    this.relayTimers.add(timer);
  }
  public prepareRelay(payload: SOSPayload, deviceId: string, location?: SOSLocation): SOSPayload {
    return { ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.BLE_RELAY,
      uploadOnly: payload.hopCount >= payload.maxHops,
      hopCount: Math.min(payload.maxHops, payload.hopCount + 1),
      relayChain: payload.relayChain.length < 15 ? [...payload.relayChain, { deviceId, timestamp: new Date().toISOString() }] : payload.relayChain };
  }
  public calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2-lat1)*rad/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lon2-lon1)*rad/2)**2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  }
  public async destroy(): Promise<void> {
    this.relayTimers.forEach(clearTimeout); this.relayTimers.clear();
    await this.stopScanning(); await this.stopAdvertising();
    this.subscriptions.forEach(subscription => subscription.remove()); this.subscriptions = [];
    this.initialized = false;
    Object.values(this.listeners).forEach(set => set.clear());
  }
}
