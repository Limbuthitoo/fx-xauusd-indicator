const appJson = require("./app.json");

const apiBaseUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  appJson.expo.extra?.apiBaseUrl ??
  "http://localhost:7073";

const easProjectId =
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
  process.env.EAS_PROJECT_ID ??
  appJson.expo.extra?.eas?.projectId;

module.exports = {
  expo: {
    ...appJson.expo,

    android: {
      ...appJson.expo.android,
      package: "com.onehub.fxindicator", // Change to your actual package
      googleServicesFile: "./google-services.json",
    },

    extra: {
      ...appJson.expo.extra,
      apiBaseUrl,
      eas: easProjectId
        ? { projectId: easProjectId }
        : appJson.expo.extra?.eas,
    },
  },
};