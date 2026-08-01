import { buildBrowserAsset } from './build-browser-asset.mjs'

await buildBrowserAsset('src/portal/search-client.ts', 'public/portal-search.js')
