import { PermissionsAndroid, Platform } from 'react-native';
import * as Peripheral from '../../modules/ble-peripheral';
import { SOSPayload, SOSCancellation, SOSLocation, DeliveryMethod } from '../interfaces/sos.types';
import { encodePayload, isLivePayload } from './ble-codec';


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
  private advertisingExpiry: ReturnType<typeof setTimeout> | undefined;

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
    const encoded = encodePayload(payload);
    await this.initialize();
    if (!(await Peripheral.startAdvertising(encoded))) throw new Error('Bluetooth advertising did not start');
    this.advertisingId = payload.sosId;
    if (this.advertisingExpiry) clearTimeout(this.advertisingExpiry);
    const remaining = Math.max(0, Date.parse(payload.timestamp) + payload.ttlSeconds * 1000 - Date.now());
    this.advertisingExpiry = setTimeout(() => {
      void this.stopAdvertising(payload.sosId).catch(error => this.emit('onError', error));
    }, remaining);
  }
  public async stopAdvertising(sosId?: string): Promise<void> {
    if (sosId) { await Peripheral.removeAdvertisement(sosId); return; }
    if (this.advertisingExpiry) clearTimeout(this.advertisingExpiry);
    if (this.initialized) await Peripheral.stopAdvertising();
    this.advertisingId = null;
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
      hopCount: payload.hopCount + 1, relayChain: [...payload.relayChain, { deviceId, timestamp: new Date().toISOString() }] };
  }
  public async broadcastCancellation(cancellation: SOSCancellation): Promise<void> {
    // Unauthenticated BLE cancellations could suppress somebody else's emergency.
    // Stop the local advert; authoritative cancellation is retried through the API.
    await this.stopAdvertising(cancellation.sosId);
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
