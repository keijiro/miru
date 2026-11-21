import { defineConfig } from 'vite'
import { mediaLibrary } from './server/media-library.ts'

export default defineConfig({
  plugins: [mediaLibrary()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/miru.config.json', '**/samples/**', '**/.miru-cache/**'],
    },
    watch: { ignored: ['**/.miru-cache/**', '**/samples/**'] },
  },
  preview: { host: 'localhost', port: 5173, strictPort: true },
})
