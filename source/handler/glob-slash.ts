// source/handler/glob-slash.ts
// Adopted from https://github.com/scottcorgan/glob-slash/ (MIT License)

import path from 'node:path';

export const normalize = (value: string): string =>
  path.posix.normalize(path.posix.join('/', value));

export const slasher = (value: string): string =>
  value.startsWith('!') ? `!${normalize(value.slice(1))}` : normalize(value);
