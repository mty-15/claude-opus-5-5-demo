// esbuild substitutes a verified, self-contained payload. Node gameplay tests
// can import Game without parsing image assets; boot requires the built HTML.
export const tacticalAssets = typeof __TACTICAL_ASSETS__ === 'undefined' ? null : __TACTICAL_ASSETS__;
