/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/shadotoma/' : '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'シャドとま',
        short_name: 'シャドとま',
        description: '英語シャドーイング練習アプリ',
        lang: 'ja',
        start_url: '.',
        display: 'standalone',
        background_color: '#fff7f5',
        theme_color: '#e0473f',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // mp3はサイズが大きく初回ビルド時のプリキャッシュには含めない（M2申し送り事項）。
        // 代わりにruntimeCachingで「一度再生した教材はオフラインでも聴ける」を実現する。
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.mp3'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'shadotoma-material-audio',
              expiration: {
                // VOA教材は最大30件程度を想定。上限を超えたら古いものから破棄する。
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 180,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));
