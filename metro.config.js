const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.alias = {
  "@": path.resolve(__dirname),
};

// @tanstack/query-core v5와 jose v6는 private class fields를 사용
// Hermes (RN 0.81.5)는 이를 지원하지 않으므로 transpile 대상에 포함
// Metro 기본값은 node_modules를 transpile하지 않음
// 아래 패턴에서 @tanstack과 jose를 제외하여 babel로 처리
config.transformer.transformIgnorePatterns = [
  "node_modules/(?!(@react-native|react-native|expo|@expo|@tanstack|jose)/)",
];

module.exports = config;
