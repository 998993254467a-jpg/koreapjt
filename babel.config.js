module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          root: ['.'],
          alias: {
            '@': '.',
          },
          extensions: ['.ios.js', '.android.js', '.js', '.ts', '.tsx', '.json'],
        },
      ],
    ],
    overrides: [
      {
        // @tanstack/query-core v5는 private class fields를 사용
        // Hermes (RN 0.81.5)가 지원하지 않으므로 transpile
        test: /node_modules\/@tanstack/,
        plugins: [
          ['@babel/plugin-transform-class-properties', { loose: true }],
          ['@babel/plugin-transform-private-methods', { loose: true }],
        ],
      },
      {
        // jose v6도 private fields 사용
        test: /node_modules\/jose/,
        plugins: [
          ['@babel/plugin-transform-class-properties', { loose: true }],
          ['@babel/plugin-transform-private-methods', { loose: true }],
        ],
      },
    ],
  };
};
