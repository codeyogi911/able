import { buildBrowserAsset } from './build-browser-asset.mjs'

await buildBrowserAsset('src/voice/demo-client.ts', 'public/voice-demo.js')
