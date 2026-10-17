import { defineConfig } from 'vite';

// Relative base so the build also works when loaded by the Tauri desktop shell.
export default defineConfig({
  base: './',
  clearScreen: false,
  server: { strictPort: true },
});
