import { useEffect, useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { bleMeshInstance } from '../services/sos-trigger.service';

const TEXT = {
  bluetooth: ['Bluetooth is off. Nearby phones cannot get or relay SOS without internet.', 'Turn on Bluetooth'],
  permission: ['Nearby devices permission is off. Phones nearby cannot get your SOS.', 'Allow permission'],
};

/** Shown while nearby SOS cannot work, since that used to fail silently. */
export function BluetoothBanner() {
  const [problem, setProblem] = useState<'bluetooth' | 'permission' | null>(null);
  useEffect(() => {
    let mounted = true;
    const check = () => { void bleMeshInstance.nearbyProblem().then(value => { if (mounted) setProblem(value); }); };
    check();
    const timer = setInterval(check, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  if (!problem) return null;
  const fix = async () => {
    if (problem === 'bluetooth') await bleMeshInstance.ensureBluetoothOn();
    // After "Don't allow" twice Android stops showing the dialog; Settings still works.
    else await bleMeshInstance.requestPermissions(true).catch(() => Linking.openSettings());
    setProblem(await bleMeshInstance.nearbyProblem());
  };
  return <View style={{ margin: 16, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#FF3B30', backgroundColor: 'rgba(255,59,48,0.15)' }}>
    <Text style={{ color: '#eee', textAlign: 'center' }}>{TEXT[problem][0]}</Text>
    <TouchableOpacity accessibilityRole="button" onPress={() => { void fix(); }}>
      <Text style={{ color: '#7af', textAlign: 'center', padding: 8 }}>{TEXT[problem][1]}</Text>
    </TouchableOpacity>
  </View>;
}
