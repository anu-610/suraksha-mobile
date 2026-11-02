import * as Location from 'expo-location';
import { SOSLocation } from '../interfaces/sos.types';
import { latestLocation } from './location-policy';

async function freshPosition(): Promise<Location.LocationObject> {
  let subscription: Location.LocationSubscription | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Location.LocationObject>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Location timed out')), 15000);
      // Unlike getCurrentPositionAsync, a watch can be stopped on timeout.
      void Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 0 }, resolve,
        message => reject(new Error(message))).then(watch => {
          subscription = watch;
          if (finished) watch.remove();
        }, reject);
    });
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    subscription?.remove();
  }
}

async function lastPosition(): Promise<Location.LocationObject | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Location.getLastKnownPositionAsync({ maxAge: 600000, requiredAccuracy: 1000 }),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export class LocationService {
  private static cached: SOSLocation | null = null;
  public static availableLocation(): SOSLocation | null {
    return this.cached?.capturedAt && Date.now() - Date.parse(this.cached.capturedAt) < 600000 ? this.cached : null;
  }
  public static async getCurrentLocation(requestPermission = true): Promise<SOSLocation> {
    const permission = await (requestPermission ? Location.requestForegroundPermissionsAsync() : Location.getForegroundPermissionsAsync());
    if (!permission.granted) throw new Error('Location permission is required to send accurate SOS coordinates.');
    let position: Location.LocationObject;
    let provider: SOSLocation['provider'] = 'gps';
    try {
      if (!await Location.hasServicesEnabledAsync()) throw new Error('Location services disabled');
      position = await freshPosition();
    } catch {
      const cached = await lastPosition();
      if (!cached) throw new Error('Unable to obtain your location. Move to an open area and try again.');
      position = cached;
      provider = 'last_known';
    }
    this.cached = latestLocation(this.cached, { latitude: position.coords.latitude, longitude: position.coords.longitude, capturedAt: new Date(position.timestamp).toISOString(),
      altitude: position.coords.altitude ?? undefined, accuracy: position.coords.accuracy ?? 1000,
      heading: position.coords.heading ?? undefined, speed: position.coords.speed ?? undefined, provider });
    if (!this.cached) throw new Error('Location provider returned an invalid fix.');
    return this.cached;
  }
}

export function locationDescription(location: SOSLocation | null): string {
  if (!location) return 'Location unavailable';
  const age = location.capturedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(location.capturedAt)) / 1000)) : null;
  const freshness = age === null ? 'capture time unknown' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)} min ago`;
  return `${age === null || age > 120 || location.provider === 'last_known' ? 'Last known location' : 'GPS location'} · ${freshness} · accuracy ±${Math.round(location.accuracy)} m`;
}
