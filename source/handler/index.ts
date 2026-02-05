// source/handler/index.ts
// Static file server handler with directory listing and file upload support.

import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  realpath,
  lstat,
  createReadStream,
  readdir,
  createWriteStream,
  access,
} from 'node:fs';
import url from 'node:url';
import { minimatch } from 'minimatch';
import { pathToRegexp, compile } from 'path-to-regexp';
import mime from 'mime-types';
import bytes from 'bytes';
import contentDisposition from 'content-disposition';
import isPathInside from 'path-is-inside';
import parseRange from 'range-parser';
import { logger } from '../utilities/logger.js';
import { slasher } from './glob-slash.js';
import { directoryTemplate, errorTemplate } from './templates.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stats, ReadStream } from 'node:fs';

const lstatAsync = promisify(lstat);
const realpathAsync = promisify(realpath);
const readdirAsync = promisify(readdir);
const accessAsync = promisify(access);

interface Key {
  name: string;
}

interface SourceMatch {
  keys: Key[];
  results: RegExpExecArray | null;
}

interface Rewrite {
  source: string;
  destination: string;
}

interface Redirect {
  source: string;
  destination: string;
  type?: number;
}

interface HeaderConfig {
  source: string;
  headers: { key: string; value: string }[];
}

export interface HandlerConfig {
  public?: string;
  cleanUrls?: boolean | string[];
  rewrites?: Rewrite[];
  redirects?: Redirect[];
  headers?: HeaderConfig[];
  directoryListing?: boolean | string[];
  trailingSlash?: boolean;
  unlisted?: string[];
  renderSingle?: boolean;
  etag?: boolean;
  symlinks?: boolean;
}

interface FileDetails {
  type: 'file' | 'folder' | 'directory';
  base: string;
  relative: string;
  title: string;
  ext: string;
  size?: string;
}

interface ErrorSpec {
  statusCode: number;
  code: string;
  message: string;
  err?: Error;
}

interface Handlers {
  lstat: (path: string, isDirectory?: boolean) => Promise<Stats>;
  realpath: (path: string) => Promise<string>;
  createReadStream: (
    path: string,
    options?: { start?: number; end?: number },
  ) => ReadStream;
  readdir: (path: string) => Promise<string[]>;
  sendError: (
    absolutePath: string,
    response: ServerResponse,
    acceptsJSON: boolean | null,
    current: string,
    handlers: Handlers,
    config: HandlerConfig,
    spec: ErrorSpec,
  ) => Promise<void>;
}

const etags = new Map<string, [Date, string]>();

const calculateSha = (
  handlers: Handlers,
  absolutePath: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    hash.update(path.extname(absolutePath));
    hash.update('-');
    const rs = handlers.createReadStream(absolutePath);
    rs.on('error', reject);
    rs.on('data', (buf: Buffer) => hash.update(buf));
    rs.on('end', () => {
      const sha = hash.digest('hex');
      resolve(sha);
    });
  });

const sourceMatches = (
  source: string,
  requestPath: string,
  allowSegments?: boolean,
): SourceMatch | null => {
  const keys: Key[] = [];
  const slashed = slasher(source);
  const resolvedPath = path.posix.resolve(requestPath);

  let results: RegExpExecArray | null = null;

  if (allowSegments) {
    const normalized = slashed.replace('*', '(.*)');
    const expression = pathToRegexp(normalized);

    results = expression.exec(resolvedPath);

    if (!results) {
      keys.length = 0;
    }
  }

  if (results || minimatch(resolvedPath, slashed)) {
    return { keys, results };
  }

  return null;
};

const toTarget = (
  source: string,
  destination: string,
  previousPath: string,
): string | null => {
  const matches = sourceMatches(source, previousPath, true);

  if (!matches) {
    return null;
  }

  const { keys, results } = matches;

  const props: Record<string, string> = {};
  const parsed = url.parse(destination);
  const normalizedDest = parsed.protocol ? destination : slasher(destination);
  const toPath = compile(normalizedDest);

  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const value = results?.[index + 1];
    if (key && value) {
      props[key.name] = value;
    }
  }

  return toPath(props);
};

const applyRewrites = (
  requestPath: string,
  rewrites: Rewrite[] = [],
  repetitive?: boolean,
): string | null => {
  const rewritesCopy = rewrites.slice();
  const fallback = repetitive ? requestPath : null;

  if (rewritesCopy.length === 0) {
    return fallback;
  }

  for (let index = 0; index < rewritesCopy.length; index++) {
    const rewrite = rewrites[index];
    if (!rewrite) continue;
    const { source, destination } = rewrite;
    const target = toTarget(source, destination, requestPath);

    if (target) {
      rewritesCopy.splice(index, 1);
      return applyRewrites(slasher(target), rewritesCopy, true);
    }
  }

  return fallback;
};

const ensureSlashStart = (target: string): string =>
  target.startsWith('/') ? target : `/${target}`;

const shouldRedirect = (
  decodedPath: string,
  config: HandlerConfig,
  cleanUrl: boolean,
): { target: string; statusCode: number } | null => {
  const { redirects = [], trailingSlash } = config;
  const slashing = typeof trailingSlash === 'boolean';
  const defaultType = 301;
  const matchHTML = /(?:\.html|\/index)$/g;

  if (redirects.length === 0 && !slashing && !cleanUrl) {
    return null;
  }

  let currentPath = decodedPath;

  if (cleanUrl && matchHTML.test(currentPath)) {
    currentPath = currentPath.replace(matchHTML, '');
    if (currentPath.includes('//')) {
      currentPath = currentPath.replace(/\/+/g, '/');
    }
    return { target: ensureSlashStart(currentPath), statusCode: defaultType };
  }

  if (slashing) {
    const parsed = path.parse(currentPath);
    const isTrailed = currentPath.endsWith('/');
    const isDotfile = parsed.name.startsWith('.');

    let target: string | null = null;

    if (!trailingSlash && isTrailed) {
      target = currentPath.slice(0, -1);
    } else if (trailingSlash && !isTrailed && !parsed.ext && !isDotfile) {
      target = `${currentPath}/`;
    }

    if (currentPath.includes('//')) {
      target = currentPath.replace(/\/+/g, '/');
    }

    if (target) {
      return { target: ensureSlashStart(target), statusCode: defaultType };
    }
  }

  for (const redirect of redirects) {
    const { source, destination, type } = redirect;
    const target = toTarget(source, destination, decodedPath);

    if (target) {
      return { target, statusCode: type ?? defaultType };
    }
  }

  return null;
};

const appendHeaders = (
  target: Record<string, string | number>,
  source: { key: string; value: string }[],
): void => {
  for (const { key, value } of source) {
    target[key] = value;
  }
};

const getHeaders = async (
  handlers: Handlers,
  config: HandlerConfig,
  current: string,
  absolutePath: string,
  stats: Stats | null,
): Promise<Record<string, string | number>> => {
  const { headers: customHeaders = [], etag = false } = config;
  const related: Record<string, string | number> = {};
  const { base } = path.parse(absolutePath);
  const relativePath = path.relative(current, absolutePath);

  if (customHeaders.length > 0) {
    for (const { source, headers } of customHeaders) {
      if (sourceMatches(source, slasher(relativePath))) {
        appendHeaders(related, headers);
      }
    }
  }

  let defaultHeaders: Record<string, string | number> = {};

  if (stats) {
    defaultHeaders = {
      'Content-Length': stats.size,
      'Content-Disposition': contentDisposition(base, { type: 'inline' }),
      'Accept-Ranges': 'bytes',
    };

    if (etag) {
      let cached = etags.get(absolutePath);
      if (!cached || Number(cached[0]) !== Number(stats.mtime)) {
        const sha = await calculateSha(handlers, absolutePath);
        cached = [stats.mtime, sha];
        etags.set(absolutePath, cached);
      }
      defaultHeaders['ETag'] = `"${cached[1]}"`;
    } else {
      defaultHeaders['Last-Modified'] = stats.mtime.toUTCString();
    }

    const contentType = mime.contentType(base);
    if (contentType) {
      defaultHeaders['Content-Type'] = contentType;
    }
  }

  const headers = { ...defaultHeaders, ...related };

  return headers;
};

const applicable = (
  decodedPath: string,
  configEntry?: boolean | string[],
): boolean => {
  if (typeof configEntry === 'boolean') {
    return configEntry;
  }

  if (Array.isArray(configEntry)) {
    for (const source of configEntry) {
      if (sourceMatches(source, decodedPath)) {
        return true;
      }
    }
    return false;
  }

  return true;
};

const getPossiblePaths = (relativePath: string, extension: string): string[] =>
  [
    path.join(relativePath, `index${extension}`),
    relativePath.endsWith('/')
      ? relativePath.replace(/\/$/g, extension)
      : relativePath + extension,
  ].filter((item) => path.basename(item) !== extension);

const findRelated = async (
  current: string,
  relativePath: string,
  rewrittenPath: string | null,
  originalStat: (filePath: string) => Promise<Stats>,
): Promise<{ stats: Stats; absolutePath: string } | null> => {
  const possible = rewrittenPath
    ? [rewrittenPath]
    : getPossiblePaths(relativePath, '.html');

  const absolutePaths = possible.map((related) => path.join(current, related));
  const results = await Promise.allSettled(
    absolutePaths.map((absPath) => originalStat(absPath)),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.status === 'fulfilled') {
      return { stats: result.value, absolutePath: absolutePaths[i] ?? '' };
    }
    if (result?.status === 'rejected') {
      const error = result.reason as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
    }
  }

  return null;
};

const canBeListed = (excluded: string[], file: string): boolean => {
  const slashed = slasher(file);

  for (const source of excluded) {
    if (sourceMatches(source, slashed)) {
      return false;
    }
  }

  return true;
};

const renderDirectory = async (
  current: string,
  acceptsJSON: boolean | null,
  handlers: Handlers,
  config: HandlerConfig,
  paths: { relativePath: string; absolutePath: string },
): Promise<{
  directory?: string;
  singleFile?: boolean;
  absolutePath?: string;
  stats?: Stats;
}> => {
  const {
    directoryListing,
    trailingSlash,
    unlisted = [],
    renderSingle,
  } = config;
  const getSlashSuffix = (): string => {
    if (typeof trailingSlash !== 'boolean') return '/';
    return trailingSlash ? '/' : '';
  };
  const slashSuffix = getSlashSuffix();
  const { relativePath, absolutePath } = paths;

  const excluded = ['.DS_Store', '.git', ...unlisted];

  if (!applicable(relativePath, directoryListing) && !renderSingle) {
    return {};
  }

  const fileNames = await handlers.readdir(absolutePath);
  const canRenderSingle = renderSingle && fileNames.length === 1;

  const filePaths = fileNames.map((file) => ({
    file,
    filePath: path.resolve(absolutePath, file),
  }));

  const statsResults = await Promise.all(
    filePaths.map(async ({ filePath }) => handlers.lstat(filePath)),
  );

  const files: FileDetails[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const fileData = filePaths[i];
    const stats = statsResults[i];
    if (!fileData || !stats) continue;

    const { file, filePath } = fileData;
    const details = path.parse(filePath);

    const fileEntry: FileDetails = {
      type: 'file',
      base: details.base,
      relative: path.join(relativePath, details.base),
      title: details.base,
      ext: '',
    };

    if (stats.isDirectory()) {
      fileEntry.base += slashSuffix;
      fileEntry.relative += slashSuffix;
      fileEntry.type = 'folder';
    } else {
      if (canRenderSingle) {
        return { singleFile: true, absolutePath: filePath, stats };
      }

      fileEntry.ext = details.ext.split('.')[1] ?? 'txt';
      fileEntry.type = 'file';
      fileEntry.size = bytes(stats.size, {
        unitSeparator: ' ',
        decimalPlaces: 0,
      });
    }

    if (canBeListed(excluded, file)) {
      files.push(fileEntry);
    }
  }

  const toRoot = path.relative(current, absolutePath);
  const directory = path.join(path.basename(current), toRoot, slashSuffix);
  const pathParts = directory.split(path.sep).filter(Boolean);

  const sortedFiles = files.sort((a, b) => {
    const aIsDir = a.type === 'folder' || a.type === 'directory';
    const bIsDir = b.type === 'folder' || b.type === 'directory';

    if (aIsDir && !bIsDir) return -1;
    if (bIsDir && !aIsDir) return 1;
    if (a.base > b.base) return 1;
    if (a.base < b.base) return -1;
    return 0;
  });

  if (toRoot.length > 0) {
    const directoryPath = [...pathParts].slice(1);
    const relative = path.join('/', ...directoryPath, '..', slashSuffix);

    sortedFiles.unshift({
      type: 'directory',
      base: '..',
      relative,
      title: relative,
      ext: '',
    });
  }

  const subPaths: { name: string; url: string }[] = [];

  for (let index = 0; index < pathParts.length; index++) {
    const parents: string[] = [];
    const isLast = index === pathParts.length - 1;

    let before = 0;
    while (before <= index) {
      const part = pathParts[before];
      if (part) parents.push(part);
      before++;
    }

    parents.shift();

    const partName = pathParts[index] ?? '';
    subPaths.push({
      name: partName + (isLast ? slashSuffix : '/'),
      url: index === 0 ? '' : parents.join('/') + slashSuffix,
    });
  }

  const spec = { files: sortedFiles, directory, paths: subPaths };
  const output = acceptsJSON ? JSON.stringify(spec) : directoryTemplate(spec);

  return { directory: output };
};

const sendError = async (
  absolutePath: string,
  response: ServerResponse,
  acceptsJSON: boolean | null,
  current: string,
  handlers: Handlers,
  config: HandlerConfig,
  spec: ErrorSpec,
): Promise<void> => {
  const { err: original, message, code, statusCode } = spec;

  if (original && process.env.NODE_ENV !== 'test') {
    logger.error(String(original));
  }

  response.statusCode = statusCode;

  if (acceptsJSON) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: { code, message } }));
    return;
  }

  let stats: Stats | null = null;
  const errorPage = path.join(current, `${statusCode}.html`);

  try {
    stats = await handlers.lstat(errorPage);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      logger.error(String(err));
    }
  }

  if (stats) {
    try {
      const stream = handlers.createReadStream(errorPage);
      const headers = await getHeaders(
        handlers,
        config,
        current,
        errorPage,
        stats,
      );
      response.writeHead(statusCode, headers);
      stream.pipe(response);
      return;
    } catch (err) {
      logger.error(String(err));
    }
  }

  const headers = await getHeaders(
    handlers,
    config,
    current,
    absolutePath,
    null,
  );
  headers['Content-Type'] = 'text/html; charset=utf-8';

  response.writeHead(statusCode, headers);
  response.end(errorTemplate({ statusCode, message }));
};

const internalError = async (
  absolutePath: string,
  response: ServerResponse,
  acceptsJSON: boolean | null,
  current: string,
  handlers: Handlers,
  config: HandlerConfig,
  err: Error,
): Promise<void> => {
  return sendError(
    absolutePath,
    response,
    acceptsJSON,
    current,
    handlers,
    config,
    {
      statusCode: 500,
      code: 'internal_server_error',
      message: 'A server error has occurred',
      err,
    },
  );
};

const getHandlers = (): Handlers => ({
  lstat: (filePath: string) => lstatAsync(filePath),
  realpath: realpathAsync,
  createReadStream,
  readdir: readdirAsync as (path: string) => Promise<string[]>,
  sendError,
});

interface ParsedFilePart {
  filename: string;
  filePath: string;
  body: string;
}

const extractFilePart = (
  part: string,
  current: string,
): ParsedFilePart | null => {
  const headerEnd = part.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  const headers = part.slice(0, headerEnd);
  const filenameMatch = /filename="(?<filenameValue>[^"]+)"/.exec(headers);

  if (!filenameMatch?.groups?.filenameValue) return null;

  const filename = filenameMatch.groups.filenameValue;
  const filePath = path.join(current, filename);

  if (!isPathInside(filePath, current)) return null;

  const bodyStart = headerEnd + 4;
  const bodyEnd = part.lastIndexOf('\r\n');
  const body = part.slice(bodyStart, bodyEnd);

  return { filename, filePath, body };
};

const writeFilePart = (
  filePart: ParsedFilePart,
): Promise<{ success: boolean; error?: string; filename?: string }> =>
  new Promise((resolve) => {
    const writeStream = createWriteStream(filePart.filePath, {
      encoding: 'binary',
    });
    writeStream.write(filePart.body, 'binary');
    writeStream.end();
    writeStream.on('finish', () =>
      resolve({ success: true, filename: filePart.filename }),
    );
    writeStream.on('error', (err) =>
      resolve({ success: false, error: err.message }),
    );
  });

const parseMultipart = async (
  request: IncomingMessage,
  current: string,
): Promise<{ success: boolean; error?: string; filename?: string }> => {
  const contentType = request.headers['content-type'] ?? '';
  const boundaryMatch = /boundary=(?<boundaryValue>.+)$/.exec(contentType);

  if (!boundaryMatch?.groups?.boundaryValue) {
    return { success: false, error: 'Invalid content type' };
  }

  const boundary = boundaryMatch.groups.boundaryValue;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  const buffer = Buffer.concat(chunks);
  const content = buffer.toString('binary');

  const parts = content.split(`--${boundary}`);
  const fileParts = parts
    .map((part) => extractFilePart(part, current))
    .filter((part): part is ParsedFilePart => part !== null);

  if (fileParts.length === 0) {
    return { success: false, error: 'No file found in request' };
  }

  const filePart = fileParts[0];
  if (!filePart) {
    return { success: false, error: 'No file found in request' };
  }

  try {
    await accessAsync(filePart.filePath);
    return {
      success: false,
      error: `File "${filePart.filename}" already exists`,
    };
  } catch {
    // File doesn't exist, we can continue
  }

  return writeFilePart(filePart);
};

export const handler = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: HandlerConfig = {},
): Promise<void> => {
  const cwd = process.cwd();
  const current = config.public ? path.resolve(cwd, config.public) : cwd;
  const handlers = getHandlers();

  let relativePath: string | null = null;
  let acceptsJSON: boolean | null = null;

  if (request.headers.accept) {
    acceptsJSON = request.headers.accept.includes('application/json');
  }

  // Handle file upload
  if (request.method === 'POST' && request.url === '/__upload') {
    const result = await parseMultipart(request, current);

    response.setHeader('Content-Type', 'application/json');
    if (result.success) {
      response.statusCode = 200;
      response.end(
        JSON.stringify({ success: true, filename: result.filename }),
      );
    } else {
      response.statusCode = 400;
      response.end(JSON.stringify({ success: false, error: result.error }));
    }
    return;
  }

  try {
    relativePath = decodeURIComponent(
      url.parse(request.url ?? '/').pathname ?? '/',
    );
  } catch {
    return sendError('/', response, acceptsJSON, current, handlers, config, {
      statusCode: 400,
      code: 'bad_request',
      message: 'Bad Request',
    });
  }

  let absolutePath = path.join(current, relativePath);

  if (!isPathInside(absolutePath, current) && absolutePath !== current) {
    return sendError(
      absolutePath,
      response,
      acceptsJSON,
      current,
      handlers,
      config,
      {
        statusCode: 400,
        code: 'bad_request',
        message: 'Bad Request',
      },
    );
  }

  const cleanUrl = applicable(relativePath, config.cleanUrls);
  const redirect = shouldRedirect(relativePath, config, cleanUrl);

  if (redirect) {
    response.writeHead(redirect.statusCode, {
      Location: encodeURI(redirect.target),
    });
    response.end();
    return;
  }

  let stats: Stats | null = null;

  if (path.extname(relativePath) !== '') {
    try {
      stats = await handlers.lstat(absolutePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        return internalError(
          absolutePath,
          response,
          acceptsJSON,
          current,
          handlers,
          config,
          error,
        );
      }
    }
  }

  const rewrittenPath = applyRewrites(relativePath, config.rewrites);

  if (!stats && (cleanUrl || rewrittenPath)) {
    try {
      const related = await findRelated(
        current,
        relativePath,
        rewrittenPath,
        handlers.lstat,
      );

      if (related) {
        stats = related.stats;
        absolutePath = related.absolutePath;
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        return internalError(
          absolutePath,
          response,
          acceptsJSON,
          current,
          handlers,
          config,
          error,
        );
      }
    }
  }

  if (!stats) {
    try {
      stats = await handlers.lstat(absolutePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        return internalError(
          absolutePath,
          response,
          acceptsJSON,
          current,
          handlers,
          config,
          error,
        );
      }
    }
  }

  if (stats?.isDirectory()) {
    try {
      const related = await renderDirectory(
        current,
        acceptsJSON,
        handlers,
        config,
        { relativePath, absolutePath },
      );

      if (related.singleFile && related.absolutePath && related.stats) {
        stats = related.stats;
        absolutePath = related.absolutePath;
      } else if (related.directory) {
        const contentType = acceptsJSON
          ? 'application/json; charset=utf-8'
          : 'text/html; charset=utf-8';

        response.statusCode = 200;
        response.setHeader('Content-Type', contentType);
        response.end(related.directory);
        return;
      } else {
        stats = null;
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        return internalError(
          absolutePath,
          response,
          acceptsJSON,
          current,
          handlers,
          config,
          error,
        );
      }
    }
  }

  const isSymLink = stats?.isSymbolicLink();

  if (!stats || (!config.symlinks && isSymLink)) {
    return handlers.sendError(
      absolutePath,
      response,
      acceptsJSON,
      current,
      handlers,
      config,
      {
        statusCode: 404,
        code: 'not_found',
        message: 'The requested path could not be found',
      },
    );
  }

  if (isSymLink) {
    try {
      absolutePath = await handlers.realpath(absolutePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw err;
      }

      return handlers.sendError(
        absolutePath,
        response,
        acceptsJSON,
        current,
        handlers,
        config,
        {
          statusCode: 404,
          code: 'not_found',
          message: 'The requested path could not be found',
        },
      );
    }
    stats = await handlers.lstat(absolutePath);
  }

  const streamOpts: { start?: number; end?: number } = {};

  if (request.headers.range && stats.size) {
    const range = parseRange(stats.size, request.headers.range);

    if (typeof range === 'object' && range.type === 'bytes' && range[0]) {
      const { start, end } = range[0];
      streamOpts.start = start;
      streamOpts.end = end;
      response.statusCode = 206;
    } else {
      response.statusCode = 416;
      response.setHeader('Content-Range', `bytes */${stats.size}`);
    }
  }

  let stream: ReadStream;

  try {
    stream = handlers.createReadStream(absolutePath, streamOpts);
  } catch (err) {
    return internalError(
      absolutePath,
      response,
      acceptsJSON,
      current,
      handlers,
      config,
      err as Error,
    );
  }

  const headers = await getHeaders(
    handlers,
    config,
    current,
    absolutePath,
    stats,
  );

  if (streamOpts.start !== undefined && streamOpts.end !== undefined) {
    headers[
      'Content-Range'
    ] = `bytes ${streamOpts.start}-${streamOpts.end}/${stats.size}`;
    headers['Content-Length'] = streamOpts.end - streamOpts.start + 1;
  }

  if (
    request.headers.range === undefined &&
    headers.ETag &&
    headers.ETag === request.headers['if-none-match']
  ) {
    response.statusCode = 304;
    response.end();
    return;
  }

  response.writeHead(response.statusCode || 200, headers);
  stream.pipe(response);
};
