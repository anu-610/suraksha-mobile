import { useEffect } from 'react';
import { requestInitialPermissions } from '../services/initial-permissions.service';
import { startMeshRuntime, stopMeshRuntime } from '../services/mesh-runtime.service';
import { bleMeshInstance } from '../services/sos-trigger.service';
import * as Notifications from 'expo-notifications';
import { router, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { AppState, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  useEffect(() => {
    let appState: { remove(): void } | undefined;
    let mounted = true;
    void requestInitialPermissions().then(() => {
      if (!mounted) return;
      // Nearby SOS needs Bluetooth: ask on open and whenever the app comes back.
      // Listening starts after the first permission dialogs so they don't overlap.
      bleMeshInstance.askOnOpen();
      appState = AppState.addEventListener('change', state => { if (state === 'active') bleMeshInstance.askOnOpen(); });
      return startMeshRuntime();
    }).catch(() => undefined);
    const notification = Notifications.addNotificationResponseReceivedListener(() => router.push('/'));
    return () => { mounted = false; appState?.remove(); notification.remove(); stopMeshRuntime(); };
  }, []);
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AppTabs />
    </ThemeProvider>
  );
}
