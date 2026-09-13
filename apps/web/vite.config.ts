import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base` must match where the app is served from.
 *
 * GitHub Pages for a project repository serves at `/<repo>/`, not at the root,
 * and a build made for `/` loads its assets from the wrong path and shows a
 * blank page. The deployment workflow sets BASE_PATH; everything else - local
 * dev, a self-hosted server at the root - gets the default.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  server: { host: true, port: 5173 },
});
