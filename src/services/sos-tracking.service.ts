import * as Location from 'expo-location';
import { Platform } from 'react-native';
export const TRACKING_TASK = 'suraksha-active-sos-location-v2';
/** Start from a foreground user action after explaining background location access. */
export async function startSOSTracking(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (!(await Location.requestForegroundPermissionsAsync()).granted) return false;
  if (!(await Location.requestBackgroundPermissionsAsync()).granted) return false;
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
export async function stopSOSTracking(): Promise<void> {
  if (Platform.OS !== 'web' && await Location.hasStartedLocationUpdatesAsync(TRACKING_TASK))
    await Location.stopLocationUpdatesAsync(TRACKING_TASK);
}
