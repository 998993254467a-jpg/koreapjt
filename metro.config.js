const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.alias = {
  "@": path.resolve(__dirname),
};

// React Native 환경에서 .native.* 파일이 우선 선택되도록 설정
// @tanstack/react-query v4는 reactBatchedUpdates.native.mjs를 제공하여 react-dom 없이 동작
config.resolver.resolverMainFields = [
  "react-native",
  "browser",
  "main",
];

// .mjs 확장자 지원 추가 (기본값에 포함되지 않을 수 있음)
const defaultSourceExts = config.resolver.sourceExts || ["js", "jsx", "ts", "tsx", "json"];
if (!defaultSourceExts.includes("mjs")) {
  config.resolver.sourceExts = [...defaultSourceExts, "mjs", "cjs"];
}

module.exports = config;
