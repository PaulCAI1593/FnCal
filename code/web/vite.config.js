// FnCal 前端：纯静态产物，由后端同端口托管（fnOS `app/www`）。
// - 不使用任何框架插件，也不再注入 Puter 本地开发插件。
// - base:'./' 让产物可放在任意子路径（fnOS 桌面 iframe 取根路径）。
// - 故意不 import `defineConfig`：配置保持纯对象，Vite 无需为加载配置解析
//   依赖图；在禁止 spawn 的沙箱/受限环境里也能直接 `npm run build`
//   （Vite 8 在 Windows 上为配置打包会执行 `net use` 探测，受限时会 EPERM）。
export default {
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    open: false,
    // 开发时把 /api 代理到自建后端（默认 5280）；dev-mock 在 5290 时可用
    // VITE_API_PROXY 覆盖。
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'http://127.0.0.1:5280',
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 4173,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // 沙箱/受限环境禁止 fork 子进程（spawn EPERM）时，仍可用线程池跑 jsdom 测试。
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['src/js/**/*.js'],
      exclude: ['src/js/views/**', 'src/js/app.js', 'src/main.js'],
    },
  },
};
