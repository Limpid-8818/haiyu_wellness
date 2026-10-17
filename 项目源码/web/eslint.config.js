// 拆分安全网：静态捕获未定义引用与未使用导出。vite build 对未导入的标识符不报错，
// 机械拆分期间以本检查作为每次提交的门槛（no-undef）。
const browserGlobals = {
  window: 'readonly', document: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
  console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', location: 'readonly', history: 'readonly', navigator: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', crypto: 'readonly', URL: 'readonly',
  URLSearchParams: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  alert: 'readonly', confirm: 'readonly', HTMLElement: 'readonly', Event: 'readonly',
  CustomEvent: 'readonly', FormData: 'readonly', MutationObserver: 'readonly',
  performance: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', DOMException: 'readonly',
};

export default [
  {
    files: ['src/**/*.jsx', 'src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browserGlobals,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
