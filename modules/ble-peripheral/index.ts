/**
 * @fileoverview TypeScript interface for the native BLE Peripheral module.
 * 
 * This bridges the native Android (Kotlin) and iOS (Swift) BLE peripheral
 * implementations to JavaScript/TypeScript via Expo Modules.
 */

import { NativeModule, requireNativeModule } from 'expo';
type EventSubscription = { remove(): void };

// ── Types ───────────────────────────────────────────────────────

export interface SOSReceivedEvent {
  payloadBase64: string;
  deviceId: string;
}

export interface DeviceDiscoveredEvent {
  deviceId: string;
  rssi: number;
  name: string;
}

export interface BleErrorEvent {
  error: string;
}

// ── Native Module Interface ─────────────────────────────────────

type BleEvents = {
  onSOSReceived: (event: SOSReceivedEvent) => void;
  onCancelReceived: (event: SOSReceivedEvent) => void;
  onDeviceDiscovered: (event: DeviceDiscoveredEvent) => void;
  onError: (event: BleErrorEvent) => void;
};
declare class BlePeripheralNativeModule extends NativeModule<BleEvents> {
  initialize(): Promise<boolean>;
  startAdvertising(payloadBase64: string): Promise<boolean>;
  stopAdvertising(): Promise<boolean>;
  startScanning(): Promise<boolean>;
  stopScanning(): Promise<boolean>;
  broadcastCancellation(cancelPayloadBase64: string): Promise<boolean>;
  isSupported(): boolean;
  removeAdvertisement(id: string): Promise<void>;
  getInbox(): Promise<string[]>;
  acknowledgeInbox(packet: string): Promise<void>;
  isBluetoothEnabled?(): Promise<boolean>;
  requestEnableBluetooth?(): Promise<boolean>;
}

// ── Load Native Module ──────────────────────────────────────────

let nativeModule: BlePeripheralNativeModule | null = null;

try {
  nativeModule = requireNativeModule<BlePeripheralNativeModule>('BlePeripheral');
} catch (e) {
  console.warn('[BlePeripheral] Native module not found. BLE is unavailable in this build.');
}

const emitter = nativeModule ? nativeModule : null;

// ── Public API ──────────────────────────────────────────────────

/**
 * Initialize the BLE peripheral module.
 * Must be called before any other BLE operations.
 */
export async function initialize(): Promise<boolean> {
  if (!nativeModule) {
    console.warn('[BlePeripheral] Mock: initialize()');
    return false;
  }
  return nativeModule.initialize();
}

/**
 * Start BLE advertising with the given SOS payload (base64 encoded).
 * This makes the device discoverable by other Suraksha phones.
 */
export async function startAdvertising(payloadBase64: string): Promise<boolean> {
  if (!nativeModule) {
    console.warn('[BlePeripheral] Mock: startAdvertising()');
    return false;
  }
  return nativeModule.startAdvertising(payloadBase64);
}

/**
 * Stop BLE advertising.
 */
export async function stopAdvertising(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.stopAdvertising();
}

/**
 * Start scanning for nearby Suraksha SOS devices.
 */
export async function startScanning(): Promise<boolean> {
  if (!nativeModule) {
    console.warn('[BlePeripheral] Mock: startScanning()');
    return false;
  }
  return nativeModule.startScanning();
}

/**
 * Stop scanning.
 */
export async function stopScanning(): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.stopScanning();
}

/**
 * Broadcast an SOS cancellation via BLE.
 */
export async function broadcastCancellation(cancelPayloadBase64: string): Promise<boolean> {
  if (!nativeModule) return false;
  return nativeModule.broadcastCancellation(cancelPayloadBase64);
}

/**
 * Check if BLE peripheral mode is supported on this device.
 */
export function isSupported(): boolean {
  if (!nativeModule) return false;
  return nativeModule.isSupported();
}

// ── Event Listeners ─────────────────────────────────────────────

/**
 * Listen for SOS payloads received from nearby devices via GATT read.
 */
export function onSOSReceived(callback: (event: SOSReceivedEvent) => void): EventSubscription | null {
  if (!emitter) return null;
  return emitter.addListener('onSOSReceived', callback);
}

/**
 * Listen for cancellation payloads received from nearby devices.
 */
export function onCancelReceived(callback: (event: SOSReceivedEvent) => void): EventSubscription | null {
  if (!emitter) return null;
  return emitter.addListener('onCancelReceived', callback);
}

/**
 * Listen for newly discovered Suraksha BLE devices.
 */
export function onDeviceDiscovered(callback: (event: DeviceDiscoveredEvent) => void): EventSubscription | null {
  if (!emitter) return null;
  return emitter.addListener('onDeviceDiscovered', callback);
}

/**
 * Listen for BLE errors.
 */
export function onError(callback: (event: BleErrorEvent) => void): EventSubscription | null {
  if (!emitter) return null;
  return emitter.addListener('onError', callback);
}


export async function getInbox(): Promise<string[]> { return nativeModule ? nativeModule.getInbox() : []; }
export async function acknowledgeInbox(packet: string): Promise<void> { await nativeModule?.acknowledgeInbox(packet); }

export async function removeAdvertisement(id: string): Promise<void> { await nativeModule?.removeAdvertisement(id); }

// Android only; other platforms report Bluetooth as available.
export async function isBluetoothEnabled(): Promise<boolean> {
  return nativeModule?.isBluetoothEnabled ? nativeModule.isBluetoothEnabled() : true;
}
/** Shows the system "turn on Bluetooth" dialog. Resolves true when Bluetooth is on. */
export async function requestEnableBluetooth(): Promise<boolean> {
  return nativeModule?.requestEnableBluetooth ? nativeModule.requestEnableBluetooth() : true;
}
