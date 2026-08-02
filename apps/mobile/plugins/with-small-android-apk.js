const { withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

function upsertGradleProperty(properties, key, value) {
  const existing = properties.find((item) => item.type === "property" && item.key === key);
  if (existing) {
    existing.value = value;
    return properties;
  }
  properties.push({ type: "property", key, value });
  return properties;
}

module.exports = function withSmallAndroidApk(config) {
  config = withGradleProperties(config, (gradleConfig) => {
    upsertGradleProperty(gradleConfig.modResults, "android.enableProguardInReleaseBuilds", "true");
    upsertGradleProperty(gradleConfig.modResults, "android.enableShrinkResourcesInReleaseBuilds", "true");
    upsertGradleProperty(gradleConfig.modResults, "reactNativeArchitectures", "arm64-v8a");
    return gradleConfig;
  });

  return withAppBuildGradle(config, (gradleConfig) => {
    let contents = gradleConfig.modResults.contents.replace(
      /def enableSeparateBuildPerCPUArchitecture = false/g,
      "def enableSeparateBuildPerCPUArchitecture = true"
    );
    if (!contents.includes("abiFilters \"arm64-v8a\"")) {
      contents = contents.replace(
        /defaultConfig\s*\{/,
        "defaultConfig {\n        ndk {\n            abiFilters \"arm64-v8a\"\n        }"
      );
    }
    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });
};
