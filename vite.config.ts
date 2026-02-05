import { defineConfig } from 'vite';
import { resolve } from 'path';
import checker from 'vite-plugin-checker';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [
    preact(),
    checker({
      typescript: true,
    }),
  ],
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    minify: true,
  },
});
