// save_media: puts a file that an external media server returned as a URL into the workspace.
//
// The agent has no general download tool, so this one reaches only the URL prefixes the owner's mcp-servers.json names under
// `mediaOrigins` (external.ts). Every hop of a redirect is checked against them before it is requested, the body is streamed
// into a temporary file outside the workspace and counted as it arrives, and the file is copied into place without
// overwriting, so a refused or failed download leaves nothing in the workspace.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localDate } from "../files.ts";
import { underMediaOrigin } from "./external.ts";
import { resolveInside } from "./guard.ts";
import { slugify } from "./image.ts";

/** The largest file save_media saves, the same as deliver sends. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10 * 60_000;

const KIND_DIRS = { image: "images", video: "video", audio: "audio" } as const;
type Kind = keyof typeof KIND_DIRS;

/** File extension by content type, for the types media servers return; anything else takes the URL's extension or its subtype. */
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
};

export interface SavedMedia {
  /** Workspace-relative path. */
  file: string;
  bytes: number;
  contentType: string;
}

export interface SaveMediaOptions {
  root: string;
  /** URL prefixes the file may come from (see mediaOriginList in external.ts). */
  origins: readonly string[];
  signal?: AbortSignal;
  /** Default MEDIA_MAX_BYTES; a parameter so that tests need no 100 MB file. */
  maxBytes?: number;
}

/** A URL without its query, which may hold a signature: the form messages and logs use. */
function shown(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function extensionFor(type: string, url: URL): string {
  const known = EXTENSIONS[type];
  if (known) return known;
  const fromUrl = path.extname(url.pathname).toLowerCase();
  if (/^\.[a-z0-9]{1,5}$/.test(fromUrl)) return fromUrl;
  const subtype = (type.split("/")[1] ?? "").replace(/[^a-z0-9]/g, "");
  return subtype ? `.${subtype.slice(0, 5)}` : "";
}

/** Downloads `url` into the workspace. Throws an Error whose message is for the agent. */
export async function saveMedia(rawUrl: string, output: string | undefined, opts: SaveMediaOptions): Promise<SavedMedia> {
  const { root, origins, maxBytes = MEDIA_MAX_BYTES } = opts;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The url is not a URL.");
  }
  if (!underMediaOrigin(url, origins)) {
    throw new Error(`${shown(url)} is not under a media origin the owner's configuration names, so it cannot be saved.`);
  }
  let target: string | undefined;
  if (output !== undefined) {
    target = resolveInside(root, output);
    if (!target) throw new Error(`${output} is outside the workspace.`);
    if (fs.existsSync(target)) throw new Error(`${output} already exists; pick another output path.`);
  }
  const stop = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const aborted = () => new Error(stop.reason instanceof DOMException && stop.reason.name === "TimeoutError" ? "The download timed out." : "The task was stopped; nothing was saved.");

  // Redirects are followed here, one at a time, so that a hop to a host outside the origins is never requested.
  let res: Response;
  for (let hops = 0; ; hops++) {
    try {
      res = await fetch(url, { redirect: "manual", signal: stop });
    } catch (err) {
      if (stop.aborted) throw aborted();
      throw new Error(`Downloading ${shown(url)} failed: ${err instanceof Error ? err.message : "unreachable"}`, { cause: err });
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await res.body?.cancel().catch(() => undefined);
    if (hops >= MAX_REDIRECTS) throw new Error(`${shown(url)} redirects more than ${MAX_REDIRECTS} times.`);
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`${shown(url)} redirects to something that is not a URL.`);
    }
    if (!underMediaOrigin(next, origins)) {
      throw new Error(`${shown(url)} redirects to ${shown(next)}, which is not under a media origin the owner's configuration names, so it was not requested.`);
    }
    url = next;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${shown(url)} answered ${res.status}.`);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const kind = contentType.split("/")[0] as Kind;
  if (!Object.hasOwn(KIND_DIRS, kind)) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${shown(url)} is ${contentType || "of an unknown type"}: only images, video and audio are saved.`);
  }
  const tooBig = (size: number) => new Error(`${shown(url)} is larger than the ${maxBytes / 1024 / 1024} MB limit (${Math.ceil(size / 1024 / 1024)} MB); nothing was saved.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig(declared);
  }
  if (!res.body) throw new Error(`${shown(url)} answered with no content.`);

  // The body goes to a temporary directory first: the workspace holds nothing of a download that fails or is too large.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-media-"));
  try {
    const part = path.join(tmp, "download");
    const handle = await fs.promises.open(part, "wx");
    let bytes = 0;
    try {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          await res.body.cancel().catch(() => undefined);
          throw tooBig(bytes);
        }
        await handle.write(chunk);
      }
    } catch (err) {
      if (stop.aborted) throw aborted();
      throw err;
    } finally {
      await handle.close();
    }
    if (!bytes) throw new Error(`${shown(url)} answered with an empty file.`);

    const file = place(part, target, { root, kind, url, contentType });
    return { file: path.relative(fs.realpathSync(root), file), bytes, contentType };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Copies the download to `target`, or to a new name under <kind dir>/<date>/ when there is none; never over a file that exists. */
function place(part: string, target: string | undefined, { root, kind, url, contentType }: { root: string; kind: Kind; url: URL; contentType: string }): string {
  const copy = (to: string): boolean => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.copyFileSync(part, to, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      fs.rmSync(to, { force: true });
      throw err;
    }
  };
  if (target) {
    if (!copy(target)) throw new Error("The output path already exists; pick another one.");
    return target;
  }
  const ext = extensionFor(contentType, url);
  let stem = "";
  try {
    stem = decodeURIComponent(path.basename(url.pathname, path.extname(url.pathname)));
  } catch {
    // An undecodable name falls back to the kind.
  }
  const slug = stem ? slugify(stem) : kind;
  for (let i = 1; ; i++) {
    const rel = path.join(KIND_DIRS[kind], localDate(), `${i === 1 ? slug : `${slug}-${i}`}${ext}`);
    const real = resolveInside(root, rel);
    if (!real) throw new Error(`${rel} is outside the workspace.`);
    if (copy(real)) return real;
  }
}
