import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/' // ← 改成你的 repo 名稱；使用者根站點請設為 '/'
})
