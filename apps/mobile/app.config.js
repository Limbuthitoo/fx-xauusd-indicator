const appJson = require("./app.json");

const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? appJson.expo.extra?.apiBaseUrl ?? "http://localhost:7073";
const easProjectId =
  process.env.EXPO_PUBLIC_EAS_PROJECT_ID ??
  process.env.EAS_PROJECT_ID ??
  appJson.expo.extra?.eas?.projectId;

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...appJson.expo.extra,
      apiBaseUrl,
      eas: easProjectId ? { projectId: easProjectId } : appJson.expo.extra?.eas
    }
  }
};
