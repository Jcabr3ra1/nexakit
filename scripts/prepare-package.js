import fs from 'node:fs/promises';

// npm omits the root package-lock.json from tarballs. Preserve reviewed lock bytes
// for the artifact verifier; this copy is generated on every pack, never edited.
await fs.mkdir(new URL('../assets/runtime/', import.meta.url), { recursive: true });
await fs.copyFile(new URL('../package-lock.json', import.meta.url), new URL('../assets/runtime/package-lock.json', import.meta.url));
