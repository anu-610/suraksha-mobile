// Test builds use a separate Android package and explicitly opt into local HTTP.
module.exports = ({ config }) => {
  if (process.env.SURAKSHA_LOCAL_TEST_BUILD !== 'true') return config;
  const origin = process.env.EXPO_PUBLIC_API_URL;
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) throw new Error('A backend origin is required for the local test APK.');
  if (process.env.EXPO_PUBLIC_ENABLE_TEST_LOGIN !== 'true') throw new Error('Enable test-account login for the local test APK.');
  return {
    ...config,
    name: 'Suraksha Test',
    version: '1.1.0',
    scheme: 'suraksha-test',
    android: { ...config.android, package: 'com.suraksha.emergency.localtest', versionCode: 7 },
    plugins: config.plugins.map(plugin => Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
      ? [plugin[0], { ...plugin[1], android: { ...plugin[1].android, usesCleartextTraffic: true } }]
      : plugin),
  };
};
