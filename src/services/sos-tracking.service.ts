import * as Location from 'expo-location';
import { Platform } from 'react-native';
export const TRACKING_TASK = 'suraksha-active-sos-location-v2';
let operations: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work, work); operations = next.catch(() => undefined); return next;
}
/** Start from a foreground user action after explaining background location access. */
export function startSOSTracking(): Promise<boolean> { return serialize(startTracking); }
async function startTracking(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (!(await Location.requestForegroundPermissionsAsync()).granted) return false;
  if (!(await Location.requestBackgroundPermissionsAsync()).granted) return false;
  if (await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK)) return true;
  await Location.startLocationUpdatesAsync(TRACKING_TASK, {
    accuracy: Location.Accuracy.High, timeInterval: 60000, distanceInterval: 0,
    deferredUpdatesInterval: 60000, pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: { notificationTitle: 'Suraksha SOS active',
      notificationBody: 'Updating your SOS location about once a minute. Cancel SOS to stop.',
      killServiceOnDestroy: false },
  });
  return true;
}
export function stopSOSTracking(): Promise<void> { return serialize(async () => {
  if (Platform.OS !== 'web' && await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK))
    await Location.stopLocationUpdatesAsync(TRACKING_TASK);
}); }
