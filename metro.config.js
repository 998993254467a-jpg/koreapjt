const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

config.resolver.alias = {
  "@": path.resolve(__dirname),
};

// React Native에는 react-dom이 없음
// @tanstack/react-query v4가 내부적으로 react-dom을 import하므로
// shim 파일로 대체하여 번들링 에러 방지
config.resolver.extraNodeModules = {
  "react-dom": path.resolve(__dirname, "shims/react-dom.js"),
};

module.exports = config;
