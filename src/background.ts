import { TRACKING_TASK, stopSOSTracking } from './services/sos-tracking.service';
import { SOSTriggerService } from './services/sos-trigger.service';
import type { LocationObject } from 'expo-location';
import { AppRegistry, Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import { processMeshWork, RETRY_TASK } from './services/mesh-runtime.service';

// Must be defined at module scope so the OS can invoke it without a mounted screen.
if (Platform.OS === 'android') AppRegistry.registerHeadlessTask('SurakshaRelay', () => processMeshWork);
if (Platform.OS !== 'web') {
  TaskManager.defineTask<{ locations: LocationObject[] }>(TRACKING_TASK, async ({ data, error }) => {
    if (!(await SOSTriggerService.activeSOS()).length) { await stopSOSTracking(); return; }
    if (error || !data?.locations.length) return;
    const fix = data.locations[data.locations.length - 1];
    if (Date.now() - fix.timestamp > 120000) return;
    await SOSTriggerService.updateActiveLocations({ latitude: fix.coords.latitude, longitude: fix.coords.longitude,
      accuracy: fix.coords.accuracy ?? 1000, provider: 'gps' });
    await processMeshWork();
  });
  TaskManager.defineTask(RETRY_TASK, async () => {
    try { await processMeshWork(); return BackgroundTask.BackgroundTaskResult.Success; }
    catch { return BackgroundTask.BackgroundTaskResult.Failed; }
  });
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldPlaySound: true,
    shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }) });
}
