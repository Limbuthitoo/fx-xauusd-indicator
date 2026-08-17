const appJson = require("./app.json");

const apiBaseUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  appJson.expo.extra?.apiBaseUrl ??
  "http://localhost:7073";

const easProjectId =
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
  process.env.EAS_PROJECT_ID ??
  appJson.expo.extra?.eas?.projectId;

const buildSeed = process.env.MOBILE_BUILD_SEED ?? new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const buildDate = new Date(
  `${buildSeed.slice(0, 4)}-${buildSeed.slice(4, 6)}-${buildSeed.slice(6, 8)}T${buildSeed.slice(8, 10)}:${buildSeed.slice(10, 12)}:${buildSeed.slice(12, 14)}Z`
);
const buildEpoch = Date.UTC(2026, 0, 1);
const detectedVersionCode = Math.floor((buildDate.getTime() - buildEpoch) / 1000);
const buildVersionCode = Number(process.env.MOBILE_VERSION_CODE) || (Number.isFinite(detectedVersionCode) ? Math.max(1, detectedVersionCode) : Math.floor(Date.now() / 1000));
const buildVersionName =
  process.env.MOBILE_VERSION_NAME ??
  `${appJson.expo.version.split(".").slice(0, 2).join(".")}.${buildVersionCode}`;

module.exports = {
  expo: {
    ...appJson.expo,
    version: buildVersionName,

    android: {
      ...appJson.expo.android,
      package: "com.onehub.fxindicator",
      versionCode: buildVersionCode,
      googleServicesFile: "./google-services.json",
    },

    extra: {
      ...appJson.expo.extra,
      apiBaseUrl,
      buildSeed,
      eas: easProjectId
        ? { projectId: easProjectId }
        : appJson.expo.extra?.eas,
    },

    plugins: [
      ...(appJson.expo.plugins ?? []),
      "expo-local-authentication",
      "./plugins/with-small-android-apk",
    ],
  },
};
