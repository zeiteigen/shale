export interface ImageCandidate {
  url: string;
  width?: number;
  height?: number;
}

/** Recognize asset identities, not words in an article title or a nested query URL. */
export function isDecorativeImageUrl(value: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(value, "https://asset.invalid/").pathname).toLowerCase();
  } catch {
    return false;
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(?:favicon(?:[-_.][\w-]+)*|apple-touch-icon(?:[-_.][\w-]+)*|apple-touch-icon-precomposed|icon-sprite|icons-sprite|sprite-icons)\.(?:ico|png|svg|gif|webp|jpe?g)$/.test(name) ||
    /\/(?:faviconv2|s2\/favicons)\/?$/.test(path);
}

/** Unknown dimensions and small substantive diagrams remain eligible. */
export function isDecorativeImage(image: ImageCandidate): boolean {
  return isDecorativeImageUrl(image.url) ||
    (image.width !== undefined && image.height !== undefined &&
      image.width > 0 && image.width <= 1 && image.height > 0 && image.height <= 1);
}
