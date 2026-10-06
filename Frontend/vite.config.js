import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
import path from 'node:path/win32'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
        "styled-system": path.resolve(__dirname, "styled-system"),
      },
    },
})
