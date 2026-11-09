// Original DS-Bot npm artifact, published from this upstream commit (Apache-2.0).
// No Bot implementation or Cordis runtime is vendored into Forge.
export const BOT_PIN = Object.freeze({
  name: 'ds-bot',
  version: '0.2.7',
  dshVersion: '0.2.1-rc.5',
  repository: 'https://github.com/Fei2411/DS-Bot',
  commit: '71d344bf193f3f18185f25de3d8e5c483046910a',
  license: 'Apache-2.0',
  tarball: 'https://registry.npmjs.org/ds-bot/-/ds-bot-0.2.7.tgz',
  integrity: 'sha512-d9t8XaD+CNwzGlTYWd6VWxBgNdLhdMbT1ag+H99ZJ19hdyShjntwhdRz+pBF8OMY4j/kSdyg0oAIF2sHNfIhoA==',
});

// Inspect the original host, compiled client, bundle, and feature implementations.
// These are artifact hashes, not copies of the upstream implementations.
export const BOT_FILES = Object.freeze({
  'index.js': 'd993aae9d99f2bdb7330a4f821636837c8491ad4b442f8b2f15c1c425dce1c8e',
  'client.js': '8d25c9a5e036cdd5c6d3bf27977ef3a49848b407e9eb2f225a12faeb55a633df',
  'cordis.patch.yml': 'ec776d258ddcc920dc8d7b743f180f87aec4e7fb559842dbfd51819a6f2ef8db',
  'src/host/tools.js': 'f3d067af9789bf7061fc2ea02c6db5e1229e6115e60b137a34f0e2e793706b09',
  'src/host/memory.js': '5e89412362f055a9351238b3d3a7c37df5d85cfd260c75a7a113d830ed2a271c',
  'src/host/groups.js': '2d8701ad88db093c776295332e736273adcd392515c3f6ccd09f364e571cd70b',
  'src/host/roster.js': '50c074138cb1da62b59df09c2d084a17f8ec1f78e05890457ef4ac45bd096947',
});

export const BOT_PROFILE = 'forge-bots';

// Artifact identity remains stable for existing managed teams. Host compatibility
// is tracked separately so extending the tested hosts does not invalidate roots.
export const BOT_DSH_VERSIONS = Object.freeze(['0.2.1-rc.5', '0.2.2-rc.1']);
