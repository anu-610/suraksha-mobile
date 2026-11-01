/** One app-level runtime; independent of mounted screens, also used by Headless JS. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as BackgroundTask from 'expo-background-task';
import * as Peripheral from '../../modules/ble-peripheral';
import * as Crypto from 'expo-crypto';
import { LocationService } from './location.service';
import { Platform } from 'react-native';
import { decodePayload, isLivePayload } from './ble-codec';
import { signOrigin, verifyOrigin } from './origin-security';
import { bleMeshInstance, SOSTriggerService } from './sos-trigger.service';
import { SOSApiService, ApiError } from './sos-api.service';
import { loadSession } from './session.service';
import { NetworkService } from './network.service';
import { ActiveSOSEvent, SOSPayload, SOSLocation, SOSMessageType, SOSStatus, DeliveryMethod } from '../interfaces/sos.types';

export const RETRY_TASK = 'suraksha-sos-retry-v2';
const TOMBSTONES = '@suraksha.mesh.cancelled.v2';
const OFFERS = '@suraksha.helper.offers.v2';
const packetKey = (p: SOSPayload) => `${p.sosId}:${p.messageType}:${p.revision ?? 0}`;
const RELAYS = '@suraksha.relay.pending.v2';
const NEARBY = '@suraksha.nearby.v2';
const FORWARDED = '@suraksha.relay.forwarded.v1';
const DISMISSED = '@suraksha.nearby.dismissed.v1';
let forwarding: Promise<void> | undefined;
const ENABLED = '@suraksha.relay.enabled.v2';
let operations: Promise<unknown> = Promise.resolve();
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work, work); operations = next.catch(() => undefined); return next;
}
async function list<T>(key: string): Promise<T[]> {
  const value = await AsyncStorage.getItem(key);
  return value ? JSON.parse(value) : [];
}
export async function nearbyEvents(): Promise<ActiveSOSEvent[]> {
  const cancelled = await list<{ id: string; owner: string; until: number }>(TOMBSTONES);
  const hidden = await list<{ id: string; until: number }>(DISMISSED);
  return (await list<ActiveSOSEvent>(NEARBY)).filter(event => isLivePayload(event) && !cancelled.some(p => p.id === event.sosId && p.owner === event.userId && p.until > Date.now()) && !hidden.some(item => item.id === event.sosId && item.until > Date.now()));
}
export async function dismissNearbySOS(id: string): Promise<void> {
  await serial(async () => {
    const event = (await list<ActiveSOSEvent>(NEARBY)).find(item => item.sosId === id);
    if (!event) return;
    const hidden = (await list<{ id: string; until: number }>(DISMISSED)).filter(item => item.until > Date.now() && item.id !== id);
    hidden.push({ id, until: Date.parse(event.timestamp) + event.ttlSeconds * 1000 });
    await AsyncStorage.setItem(DISMISSED, JSON.stringify(hidden));
  });
  await Notifications.dismissNotificationAsync(`sos-${id}`).catch(() => undefined);
}
async function location(): Promise<SOSLocation | undefined> {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: 600000, requiredAccuracy: 1000 });
    if (fix) return { latitude: fix.coords.latitude, longitude: fix.coords.longitude, accuracy: fix.coords.accuracy ?? 1000, provider: 'last_known' };
  } catch { /* Background code never opens a permission prompt. */ }
}
async function notify(event: ActiveSOSEvent) {
  if (Platform.OS === 'web') return;
  const distance = event.distanceMeters === undefined ? 'Distance unavailable' : `${Math.round(event.distanceMeters)} m away`;
  await Notifications.scheduleNotificationAsync({ identifier: `sos-${event.sosId}`, content: { title: `Nearby ${event.sosType} SOS`,
    body: `${event.userName}: ${distance}. Open Suraksha to view location and offer help.`,
    sound: 'default', data: { sosId: event.sosId }, categoryIdentifier: 'SOS_HELP' }, trigger: Platform.OS === 'android' ? { channelId: 'sos-alerts' } : null });
}
async function receiveMeshInbox(): Promise<void> {
  return serial(async () => {
    const session = await loadSession();
    if (!session) return;
    const deviceId = await SOSTriggerService.getDeviceId();
    const selfLocation = await location();
    let events = (await list<ActiveSOSEvent>(NEARBY)).filter(isLivePayload);
    let pending = (await list<SOSPayload>(RELAYS)).filter(isLivePayload);
    const cancelled = (await list<{ id: string; owner: string; until: number }>(TOMBSTONES)).filter(p => p.until > Date.now());
    const forwarded = (await list<{ id: string; until: number }>(FORWARDED)).filter(item => item.until > Date.now());
    let offers = (await list<SOSPayload>(OFFERS)).filter(isLivePayload);
    for (const packet of await Peripheral.getInbox()) {
      let payload: SOSPayload;
      try { payload = decodePayload(packet); await verifyOrigin(payload); }
      catch { await Peripheral.acknowledgeInbox(packet); continue; }
      if (payload.originDeviceId === deviceId || payload.relayChain.some(node => node.deviceId === deviceId)) {
        await Peripheral.acknowledgeInbox(packet); continue;
      }
      const cancellation = payload.messageType === SOSMessageType.SOS_CANCEL;
      const helper = payload.messageType === SOSMessageType.SOS_HELPER;
      const tombstone = cancelled.some(p => p.id === payload.sosId && p.owner === payload.userId);
      if (!cancellation && tombstone) { await Peripheral.acknowledgeInbox(packet); continue; }
      const previous = events.find(p => p.sosId === payload.sosId);
      if (previous && previous.userId !== payload.userId) { await Peripheral.acknowledgeInbox(packet); continue; }
      if (cancellation) {
        if (!tombstone) cancelled.push({ id: payload.sosId, owner: payload.userId,
          until: Date.parse(payload.timestamp) + 3900000 });
        events = events.filter(p => p.sosId !== payload.sosId);
        pending = pending.filter(p => p.sosId !== payload.sosId || p.messageType === SOSMessageType.SOS_CANCEL);
        offers = offers.filter(p => p.targetSosId !== payload.sosId);
        await AsyncStorage.setItem(TOMBSTONES, JSON.stringify(cancelled));
        if (!tombstone && payload.hopCount >= payload.maxHops) await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
        await Notifications.dismissNotificationAsync(`sos-${payload.sosId}`).catch(() => undefined);
      } else if (helper) {
        if (payload.targetDeviceId === deviceId) {
          const own = await SOSTriggerService.activeSOS();
          if (own.some(p => p.sosId === payload.targetSosId && p.helperRequested))
            offers = [...offers.filter(p => p.sosId !== payload.sosId), payload].slice(-100);
        }
      } else if (!previous || (payload.revision ?? 0) > (previous.revision ?? 0)) {
        const distanceMeters = selfLocation && payload.location ? bleMeshInstance.calculateDistance(selfLocation.latitude, selfLocation.longitude,
          payload.location.latitude, payload.location.longitude) : undefined;
        const event = { ...payload, distanceMeters };
        events = [...events.filter(p => p.sosId !== payload.sosId).slice(-199), event];
        bleMeshInstance.reportReceived(event);
        if (payload.helperRequested && !previous?.helperRequested) {
          const hidden = await list<{ id: string; until: number }>(DISMISSED);
          await AsyncStorage.setItem(DISMISSED, JSON.stringify(hidden.filter(p => p.id !== payload.sosId)));
          await Notifications.scheduleNotificationAsync({ identifier: `helper-${payload.sosId}`,
            content: { title: 'Location sharing request', body: `${payload.userName} asks to approach an online helper. Open Suraksha to agree or decline.` },
            trigger: null }).catch(() => undefined);
        } else if (!previous) await notify(event).catch(() => undefined);
      } else if ((payload.revision ?? 0) < (previous.revision ?? 0)) {
        await Peripheral.acknowledgeInbox(packet); continue;
      }
      if (!forwarded.some(item => item.id === packetKey(payload)) && payload.hopCount < payload.maxHops &&
          !pending.some(item => packetKey(item) === packetKey(payload))) {
        pending = pending.filter(p => p.sosId !== payload.sosId);
        pending.push(bleMeshInstance.prepareRelay(payload, deviceId));
      }
      await AsyncStorage.setItem(NEARBY, JSON.stringify(events));
      await AsyncStorage.setItem(OFFERS, JSON.stringify(offers));
      await AsyncStorage.setItem(RELAYS, JSON.stringify(pending));
      if ((cancellation || helper || payload.helperRequested) && payload.hopCount < payload.maxHops)
        await bleMeshInstance.startAdvertising(bleMeshInstance.prepareRelay(payload, deviceId)).catch(() => undefined);
      await Peripheral.acknowledgeInbox(packet);
    }
  });
}
export async function helperOffers(sosId: string): Promise<SOSPayload[]> {
  return (await list<SOSPayload>(OFFERS)).filter(p => p.targetSosId === sosId && isLivePayload(p));
}
/** Called only after a helper explicitly agrees in the UI. No automatic location sharing. */
export async function shareHelperLocation(event: SOSPayload): Promise<void> {
  const session = await loadSession();
  if (!session || !event.helperRequested || !isLivePayload(event)) throw new Error('This help request is no longer available.');
  if (!(await NetworkService.checkConnectivity()).isOnline) throw new Error('Connect to the backend before offering an online meeting point.');
  // Confirm this SOS reached the backend before describing this phone as an online helper.
  await SOSApiService.sendSOS(bleMeshInstance.prepareRelay(event, await SOSTriggerService.getDeviceId()));
  const fix = await LocationService.getCurrentLocation();
  if (fix.provider === 'last_known') throw new Error('Wait for a fresh GPS fix before sharing a meeting point.');
  const timestamp = new Date().toISOString();
  const offer: SOSPayload = { ...event, protocolVersion: 2, revision: 0, sosId: Crypto.randomUUID(),
    messageType: SOSMessageType.SOS_HELPER, userId: session.user.user_id, userName: session.user.name,
    userPhone: '', originDeviceId: await SOSTriggerService.getDeviceId(), timestamp, createdAt: timestamp,
    targetSosId: event.sosId, targetDeviceId: event.originDeviceId, helperRequested: false,
    location: fix, ttlSeconds: 300, hopCount: 0, relayChain: [], status: SOSStatus.ACTIVE,
    deliveryMethod: DeliveryMethod.BLE_RELAY, message: 'You may approach me if it is safe.' };
  offer.originProof = await signOrigin(offer, false);
  await serial(async () => {
    const queue = (await list<SOSPayload>(RELAYS)).filter(isLivePayload);
    await AsyncStorage.setItem(RELAYS, JSON.stringify([...queue, offer]));
  });
  await bleMeshInstance.startAdvertising(offer);
}
// Incoming packets and notifications never wait for an API upload. Only short
// storage updates share the inbox lock; the single upload pump reconciles IDs.
export async function processMeshWork(): Promise<void> {
  await receiveMeshInbox();
  void SOSTriggerService.updateActiveLocations().catch(() => undefined);
  if (!forwarding) forwarding = forwardPending().finally(() => { forwarding = undefined; });
  await forwarding;
}
async function forwardPending(): Promise<void> {
  const pending = await serial(async () => {
    const cancelled = await list<{ id: string; owner: string; until: number }>(TOMBSTONES);
    const live = (await list<SOSPayload>(RELAYS)).filter(p => isLivePayload(p) &&
      (p.messageType === SOSMessageType.SOS_CANCEL || !cancelled.some(c => c.id === p.sosId && c.owner === p.userId && c.until > Date.now())));
    await AsyncStorage.setItem(RELAYS, JSON.stringify(live));
    return live;
  });
  const { isOnline } = await NetworkService.checkConnectivity().catch(() => ({ isOnline: false }));
  for (const payload of pending) {
    let delivered = false;
    let cancelled = false;
    if (isOnline && payload.messageType !== SOSMessageType.SOS_HELPER) {
      try { await SOSApiService.sendSOS(payload); delivered = true; }
      catch (error) { if (error instanceof ApiError && error.status === 410) { delivered = true; cancelled = true; } }
    }
    if (delivered) {
      await serial(async () => {
        const forwarded = (await list<{ id: string; until: number }>(FORWARDED)).filter(item => item.until > Date.now() && item.id !== packetKey(payload));
        forwarded.push({ id: packetKey(payload), until: Date.parse(payload.timestamp) + payload.ttlSeconds * 1000 });
        await AsyncStorage.setItem(FORWARDED, JSON.stringify(forwarded));
        const latest = (await list<SOSPayload>(RELAYS)).filter(item => packetKey(item) !== packetKey(payload) && isLivePayload(item));
        await AsyncStorage.setItem(RELAYS, JSON.stringify(latest));
        if (cancelled) await AsyncStorage.setItem(NEARBY, JSON.stringify((await list<ActiveSOSEvent>(NEARBY)).filter(item => item.sosId !== payload.sosId)));
      });
    } else await serial(async () => {
      // Cancellation or a newer revision may have replaced this snapshot during upload.
      if ((await list<SOSPayload>(RELAYS)).some(p => packetKey(p) === packetKey(payload)))
        await bleMeshInstance.startAdvertising(payload).catch(() => undefined);
    });
  }
  await SOSTriggerService.retryPendingQueue();
}
export async function setRelayEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    if (!(await loadSession())) throw new Error('Sign in and enroll this device before enabling relay.');
    await bleMeshInstance.requestPermissions();
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.granted) void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => undefined);
    if (Platform.OS !== 'web') {
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('sos-alerts', { name: 'Nearby SOS alerts', importance: Notifications.AndroidImportance.HIGH });
      await Notifications.requestPermissionsAsync();
      await Notifications.setNotificationCategoryAsync('SOS_HELP', [{ identifier: 'OPEN_SOS', buttonTitle: 'View and help', options: { opensAppToForeground: true } }]);
    }
    await bleMeshInstance.startScanning();
  } else { await bleMeshInstance.stopScanning(); }
  await AsyncStorage.setItem(ENABLED, String(enabled));
}
export async function isRelayEnabled(): Promise<boolean> { return await AsyncStorage.getItem(ENABLED) === 'true'; }
export async function startMeshRuntime(): Promise<void> {
  if (unsubscribe) return;
  const work = () => { void processMeshWork().catch(error => console.warn('SOS work deferred', error instanceof Error ? error.message : 'unknown')); };
  bleMeshInstance.on('onInboxReady', work);
  const stopNetwork = NetworkService.subscribe(online => { if (online) work(); });
  timer = setInterval(work, 10000);
  unsubscribe = () => { stopNetwork(); bleMeshInstance.off('onInboxReady', work); if (timer) clearInterval(timer); unsubscribe = undefined; };
  if (Platform.OS !== 'web') {
    if (await isRelayEnabled()) await bleMeshInstance.startScanning().catch(() => undefined);
    if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Available) {
      await BackgroundTask.registerTaskAsync(RETRY_TASK, { minimumInterval: 15 });
    }
  }
  work();
}
export function stopMeshRuntime() { unsubscribe?.(); }
