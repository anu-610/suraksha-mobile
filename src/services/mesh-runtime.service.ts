/** App-level relay runtime, also used by Android Headless JS. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as BackgroundTask from 'expo-background-task';
import * as Peripheral from '../../modules/ble-peripheral';
import { Platform } from 'react-native';
import { decodePayload, isLivePayload } from './ble-codec';
import { verifyOrigin, renewDeviceIfNeeded } from './origin-security';
import { bleMeshInstance, SOSTriggerService } from './sos-trigger.service';
import { SOSApiService, ApiError } from './sos-api.service';
import { loadSession } from './session.service';
import { NetworkService } from './network.service';
import { ActiveSOSEvent, SOSPayload, SOSLocation, SOSMessageType } from '../interfaces/sos.types';
import { KEYS, serial, list, enqueue, Tombstone } from './mesh-store';
import { canReplace, expiresAt, packetKey, packetPriority, requestId, requestIsOpen } from './mesh-policy';
import { queuePeerReceipt, queueServerReceipt } from './mesh-receipts';
import { mayUpload, uploadFailed, uploadSucceeded } from './retry-policy';
import type { HelperChoice } from './helper-consent.service';
import { latestLocation } from './location-policy';
export { shareHelperLocation, respondToHelper, helperChoices, helperResponseState } from './helper-consent.service';

export const RETRY_TASK = 'suraksha-sos-retry-v2';
const ENABLED = '@suraksha.relay.enabled.v2';
let forwarding: Promise<void> | undefined;
let receiving: Promise<void> | undefined;
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

export async function nearbyEvents(): Promise<ActiveSOSEvent[]> {
  const cancelled = await list<Tombstone>(KEYS.tombstones);
  const hidden = await list<{ id: string; until: number }>(KEYS.dismissed);
  return (await list<ActiveSOSEvent>(KEYS.nearby)).filter(event => isLivePayload(event) &&
    !cancelled.some(p => p.id === event.sosId && p.owner === event.userId && p.until > Date.now()) &&
    !hidden.some(p => p.id === event.sosId && p.until > Date.now()));
}
export async function dismissNearbySOS(id: string): Promise<void> {
  await serial(async () => {
    const event = (await list<ActiveSOSEvent>(KEYS.nearby)).find(p => p.sosId === id);
    if (!event) return;
    const hidden = (await list<{ id: string; until: number }>(KEYS.dismissed)).filter(p => p.until > Date.now() && p.id !== id);
    await AsyncStorage.setItem(KEYS.dismissed, JSON.stringify([...hidden, { id, until: expiresAt(event) }]));
  });
  await Promise.all(['sos', 'helper'].map(prefix => Notifications.dismissNotificationAsync(`${prefix}-${id}`).catch(() => undefined)));
}
async function cachedLocation(): Promise<SOSLocation | undefined> {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: 600000, requiredAccuracy: 1000 });
    if (fix) return { latitude: fix.coords.latitude, longitude: fix.coords.longitude, accuracy: fix.coords.accuracy ?? 1000,
      provider: 'last_known', capturedAt: Number.isFinite(fix.timestamp) ? new Date(fix.timestamp).toISOString() : undefined };
  } catch { /* Background work never prompts for permissions. */ }
}
async function notify(event: ActiveSOSEvent, helper: boolean) {
  if (Platform.OS === 'web') return;
  await Notifications.scheduleNotificationAsync({ identifier: `${helper ? 'helper' : 'sos'}-${event.sosId}`,
    content: { title: helper ? 'Location sharing request' : `Nearby ${event.sosType} SOS`,
      body: helper ? `${event.userName} asks to approach an online helper. Open Suraksha to agree or decline.` :
        `${event.userName}: ${event.distanceMeters === undefined ? 'Distance unavailable' : `${Math.round(event.distanceMeters)} m away`}. Open Suraksha for location and help options.`,
      sound: 'default', data: { sosId: event.sosId }, categoryIdentifier: 'SOS_HELP' },
    trigger: Platform.OS === 'android' ? { channelId: 'sos-alerts' } : null });
}
function broadcast(packet: SOSPayload) {
  if (!packet.uploadOnly) void bleMeshInstance.startAdvertising(packet).catch(() => undefined);
}
async function markCancelled(id: string, owner: string, until: number) {
  const tombstones = (await list<Tombstone>(KEYS.tombstones)).filter(p => p.until > Date.now() && !(p.id === id && p.owner === owner));
  await AsyncStorage.setItem(KEYS.tombstones, JSON.stringify([...tombstones, { id, owner, until }]));
  await AsyncStorage.setItem(KEYS.nearby, JSON.stringify((await list<SOSPayload>(KEYS.nearby)).filter(p => !(p.sosId === id && p.userId === owner))));
  await AsyncStorage.setItem(KEYS.relays, JSON.stringify((await list<SOSPayload>(KEYS.relays)).filter(p =>
    !(p.sosId === id && p.userId === owner && p.messageType === SOSMessageType.SOS_ALERT) && !(p.targetSosId === id && p.messageType === SOSMessageType.SOS_HELPER))));
  await AsyncStorage.setItem(KEYS.offers, JSON.stringify((await list<SOSPayload>(KEYS.offers)).filter(p => p.targetSosId !== id)));
  const outgoing = await list<HelperChoice>(KEYS.outgoing);
  await AsyncStorage.setItem(KEYS.outgoing, JSON.stringify(outgoing.map(p => p.sosId === id ? { ...p, state: 'withdrawn', operation: 'cancelled', packet: undefined } : p)));
}
async function receiveInbox(): Promise<void> {
  const session = await loadSession();
  if (!session) return;
  const deviceId = await SOSTriggerService.getDeviceId();
  const selfLocation = await cachedLocation();
  let failure: unknown;
  for (const encoded of await Peripheral.getInbox()) {
    // One packet that hits a storage or native error stays in the native inbox
    // for the next tick; it must not hold back the packets behind it.
    try { await receivePacket(encoded, deviceId, session, selfLocation); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}
async function receivePacket(encoded: string, deviceId: string, session: NonNullable<Awaited<ReturnType<typeof loadSession>>>,
    selfLocation: SOSLocation | undefined): Promise<void> {
  let payload: SOSPayload;
  try { payload = decodePayload(encoded); await verifyOrigin(payload); }
  catch { await Peripheral.acknowledgeInbox(encoded); return; }
  if (payload.originDeviceId === deviceId || payload.relayChain.some(p => p.deviceId === deviceId)) {
    await Peripheral.acknowledgeInbox(encoded); return;
  }
  let packet: SOSPayload | undefined;
  let eventToNotify: ActiveSOSEvent | undefined;
  let helperNotice = false;
  let retired: string | undefined;
  let accepted = false;
  const own = payload.messageType === SOSMessageType.SOS_HELPER && payload.targetDeviceId === deviceId ? await SOSTriggerService.activeSOS() : [];
  await serial(async () => {
    const cancelled = (await list<Tombstone>(KEYS.tombstones)).filter(p => p.until > Date.now());
    if (payload.messageType !== SOSMessageType.SOS_CANCEL && cancelled.some(p =>
        p.id === payload.sosId && p.owner === payload.userId || payload.messageType === SOSMessageType.SOS_HELPER && p.id === payload.targetSosId)) return;
    const events = (await list<ActiveSOSEvent>(KEYS.nearby)).filter(isLivePayload);
    const previous = events.find(p => p.sosId === payload.sosId);
    if (previous && previous.userId !== payload.userId) return;
    if (payload.messageType === SOSMessageType.SOS_CANCEL) {
      retired = payload.sosId;
      await markCancelled(payload.sosId, payload.userId, expiresAt(payload) + 300000);
    } else if (payload.messageType === SOSMessageType.SOS_ACK) {
      if (payload.receiptKind === 'server' && payload.receiptStatus === 'cancelled' && payload.receiptUserId) {
        retired = payload.targetSosId;
        await markCancelled(payload.targetSosId!, payload.receiptUserId, expiresAt(payload) + 300000);
      }
    } else if (payload.messageType === SOSMessageType.SOS_HELPER) {
      const target = events.find(p => p.sosId === payload.targetSosId);
      if (target && (!requestIsOpen(target) || requestId(target) !== requestId(payload))) return;
      if (payload.targetDeviceId === deviceId) {
        if (!own.some(p => p.sosId === payload.targetSosId && requestIsOpen(p) && requestId(p) === requestId(payload))) return;
        const offers = await list<SOSPayload>(KEYS.offers);
        if (!canReplace(offers.find(p => p.sosId === payload.sosId), payload)) return;
        await AsyncStorage.setItem(KEYS.offers, JSON.stringify([...offers.filter(p => p.sosId !== payload.sosId && expiresAt(p) + 3600000 > Date.now()), payload].slice(-100)));
      }
    } else {
      if (previous && (payload.revision ?? 0) < (previous.revision ?? 0)) return;
      if (!previous || (payload.revision ?? 0) > (previous.revision ?? 0)) {
        const location = latestLocation(previous?.location ?? null, payload.location);
        const distanceMeters = selfLocation && location ? bleMeshInstance.calculateDistance(selfLocation.latitude, selfLocation.longitude,
          location.latitude, location.longitude) : undefined;
        // This is the display snapshot only. Forward the untouched signed packet.
        const event = { ...payload, location, distanceMeters };
        await AsyncStorage.setItem(KEYS.nearby, JSON.stringify([...events.filter(p => p.sosId !== payload.sosId).slice(-199), event]));
        helperNotice = requestIsOpen(payload) && (!previous || !requestIsOpen(previous) || requestId(previous) !== requestId(payload));
        if (helperNotice) {
          const hidden = await list<{ id: string; until: number }>(KEYS.dismissed);
          await AsyncStorage.setItem(KEYS.dismissed, JSON.stringify(hidden.filter(p => p.id !== payload.sosId)));
        }
        if (helperNotice || !previous) eventToNotify = event;
        // A new request/withdrawal cannot leave an old helper snapshot queued.
        if (!requestIsOpen(payload) || previous && requestId(previous) !== requestId(payload)) {
          await AsyncStorage.setItem(KEYS.relays, JSON.stringify((await list<SOSPayload>(KEYS.relays)).filter(p =>
            !(p.messageType === SOSMessageType.SOS_HELPER && p.targetSosId === payload.sosId &&
              (!requestIsOpen(payload) || requestId(p) !== requestId(payload))))));
        }
      }
    }
    accepted = true;
    // Hop limits stop further radio forwarding, not the final internet upload.
    if (payload.hopCount < payload.maxHops || [SOSMessageType.SOS_ALERT, SOSMessageType.SOS_CANCEL].includes(payload.messageType)) {
      const candidate = bleMeshInstance.prepareRelay(payload, deviceId);
      if (await enqueue(candidate)) packet = candidate;
    }
  });
  if (retired) {
    // The cancellation packet itself remains eligible to advertise.
    await bleMeshInstance.retireSOS(retired, payload.messageType === SOSMessageType.SOS_CANCEL && payload.hopCount < payload.maxHops).catch(() => undefined);
    await Promise.all(['sos', 'helper'].map(prefix => Notifications.dismissNotificationAsync(`${prefix}-${retired}`).catch(() => undefined)));
  }
  if (accepted && payload.messageType === SOSMessageType.SOS_ACK) await SOSTriggerService.acceptReceipt(payload);
  if (packet) broadcast(packet);
  if (eventToNotify) { bleMeshInstance.reportReceived(eventToNotify); await notify(eventToNotify, helperNotice).catch(() => undefined); }
  if (accepted) await queuePeerReceipt(payload, deviceId, session.user.user_id, session.user.name).catch(() => undefined);
  await Peripheral.acknowledgeInbox(encoded); // Durable writes always precede native ACK.
}
export async function helperOffers(sosId: string): Promise<SOSPayload[]> {
  const own = (await SOSTriggerService.activeSOS()).find(p => p.sosId === sosId);
  if (!own || own.helperState === 'withdrawn') return [];
  return (await list<SOSPayload>(KEYS.offers)).filter(p => p.targetSosId === sosId && requestId(p) === requestId(own));
}
export async function processMeshWork(): Promise<void> {
  if (!receiving) receiving = receiveInbox().finally(() => { receiving = undefined; });
  // An inbox error must not block uploads of packets that are already queued.
  const inboxError = await receiving.then(() => undefined, (error: unknown) => error ?? new Error('BLE inbox failed'));
  void SOSTriggerService.updateActiveLocations().catch(() => undefined);
  if (!forwarding) forwarding = forwardPending().finally(() => { forwarding = undefined; });
  await Promise.all([forwarding, SOSTriggerService.retryPendingQueue()]);
  if (inboxError) throw inboxError;
}
async function forwardPending(): Promise<void> {
  const pending = await serial(async () => {
    const cancelled = (await list<Tombstone>(KEYS.tombstones)).filter(p => p.until > Date.now());
    const live = (await list<SOSPayload>(KEYS.relays)).filter(p => isLivePayload(p) &&
      (p.messageType !== SOSMessageType.SOS_ALERT || !cancelled.some(c => c.id === p.sosId && c.owner === p.userId)) &&
      (p.messageType !== SOSMessageType.SOS_HELPER || !cancelled.some(c => c.id === p.targetSosId)));
    await AsyncStorage.setItem(KEYS.relays, JSON.stringify(live));
    return live.sort((a, b) => packetPriority(a) - packetPriority(b));
  });
  const forwarded = (await list<{ id: string; until: number }>(KEYS.forwarded)).filter(p => p.until > Date.now());
  const uploads: SOSPayload[] = [];
  for (const packet of pending) {
    broadcast(packet);
    if ([SOSMessageType.SOS_ALERT, SOSMessageType.SOS_CANCEL].includes(packet.messageType) &&
        !forwarded.some(p => p.id === packetKey(packet)) && await mayUpload(packet)) uploads.push(packet);
  }
  if (!uploads.length || !(await NetworkService.checkConnectivity().catch(() => ({ isOnline: false }))).isOnline) return;
  for (const payload of uploads) {
    const present = await serial(async () => (await list<SOSPayload>(KEYS.relays)).some(p => packetKey(p) === packetKey(payload)));
    if (!present || !await mayUpload(payload)) continue;
    let receipt: string | undefined;
    let retired = false;
    try { receipt = (await SOSApiService.sendSOS(payload)).receipt; }
    catch (error) {
      if (error instanceof ApiError && error.status === 410) { receipt = error.receipt; retired = true; }
      else { await uploadFailed(payload, error); continue; }
    }
    // Persist the reverse-path receipt before marking an upload complete. If a
    // crash happens here, the idempotent upload can be safely repeated.
    // The server already has the packet. A receipt we cannot verify or store
    // (e.g. CA key not saved yet) must not turn that into an endless re-upload
    // that also blocks every packet after this one.
    if (receipt) await queueServerReceipt(receipt).catch(error => console.warn('Server receipt skipped', error instanceof Error ? error.message : 'unknown'));
    await uploadSucceeded(payload);
    await serial(async () => {
      const latest = (await list<{ id: string; until: number }>(KEYS.forwarded)).filter(p => p.until > Date.now() && p.id !== packetKey(payload));
      await AsyncStorage.setItem(KEYS.forwarded, JSON.stringify([...latest, { id: packetKey(payload), until: expiresAt(payload) + 300000 }]));
      if (retired) await markCancelled(payload.sosId, payload.userId, Date.now() + 3900000);
      // Keep the packet in the radio queue through its TTL even after HTTP
      // success, so a transient/full native queue can recover on the next tick.
    });
    if (retired) await bleMeshInstance.retireSOS(payload.sosId).catch(() => undefined);
  }
}
export async function setRelayEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    if (!(await loadSession())) throw new Error('Sign in and enroll this device before enabling relay.');
    await bleMeshInstance.requestPermissions();
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.granted) void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => undefined);
    // Relay starts even if this is declined; scanning begins when Bluetooth comes on.
    await bleMeshInstance.ensureBluetoothOn();
    // Android 11 and older return no BLE scan results while the Location switch is off.
    if (Platform.OS === 'android' && Number(Platform.Version) < 31 && !(await Location.hasServicesEnabledAsync().catch(() => true)))
      await Location.enableNetworkProviderAsync().catch(() => undefined);
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
  const work = () => {
    void renewDeviceIfNeeded().catch(() => undefined);
    void processMeshWork().catch(error => console.warn('SOS work deferred', error instanceof Error ? error.message : 'unknown'));
  };
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
