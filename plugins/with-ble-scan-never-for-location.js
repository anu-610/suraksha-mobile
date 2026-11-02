// Without this flag Android treats BLE scans as location access: with the phone's
// Location switch off, scan results are dropped silently, so relay "sometimes"
// worked (only on phones that had location on). We never derive location from
// scans; GPS comes from expo-location. Applies to Android 12+.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withBleScanNeverForLocation(config) {
  return withAndroidManifest(config, result => {
    const manifest = result.modResults.manifest;
    manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
    const permissions = manifest['uses-permission'] || (manifest['uses-permission'] = []);
    let scan = permissions.find(p => p.$['android:name'] === 'android.permission.BLUETOOTH_SCAN');
    if (!scan) permissions.push(scan = { $: { 'android:name': 'android.permission.BLUETOOTH_SCAN' } });
    scan.$['android:usesPermissionFlags'] = 'neverForLocation';
    scan.$['tools:targetApi'] = 's';
    return result;
  });
};
