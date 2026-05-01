import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './src/manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [crx({ manifest })],
  server: {
    // Required for @crxjs/vite-plugin with Vite 5+:
    // the service worker / content scripts fetch HMR runtime from
    // localhost:5173, which Vite 5 blocks by default via CORS.
    cors: {
      origin: [/chrome-extension:\/\//],
    },
    // Use a stable port so the extension's HMR client always finds it.
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        // Bundle sidepanel.html (loaded via iframe from web_accessible_resources)
        // so its CSS + TS get processed by Vite.
        sidepanel: resolve(__dirname, 'src/sidepanel/sidepanel.html'),
      },
    },
  },
});
