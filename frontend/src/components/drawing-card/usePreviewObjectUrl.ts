import { useEffect, useRef, useState } from "react";
import { stripPreviewBackground } from "../../utils/previewSvg";

/**
 * Rasterisation bridge for the dashboard card thumbnail.
 *
 * The preview is an SVG string (server-supplied or generated client-side). We
 * used to inject it inline via `dangerouslySetInnerHTML`, which puts hundreds
 * of vector nodes per card into the live DOM — with dozens of cards that paint
 * cost is what made fast scrolling checkerboard / stutter (round-3 root cause).
 *
 * Instead we wrap the SVG in a Blob and hand the browser an object URL to load
 * as an `<img>`. The browser rasterises + caches the bitmap once; scrolling is
 * then pure GPU compositing with near-zero main-thread cost.
 *
 * The object URL is revoked whenever the source SVG changes and on unmount, so
 * repeated scrolling / collection switching does not leak memory.
 */
export const usePreviewObjectUrl = (
  previewSvg: string | null,
  hasEmbeddedImages: boolean,
): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    // Revoke any previous URL before creating a new one.
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }

    if (!previewSvg || typeof URL === "undefined" || !URL.createObjectURL) {
      setUrl(null);
      return;
    }

    // Path-only previews get their white background stripped so the img can be
    // re-tinted per theme (white bg in light, inverted-on-transparent in dark).
    // Previews with embedded raster images keep their background as-is.
    const svg = hasEmbeddedImages
      ? previewSvg
      : (stripPreviewBackground(previewSvg) ?? previewSvg);

    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    urlRef.current = objectUrl;
    setUrl(objectUrl);

    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [previewSvg, hasEmbeddedImages]);

  return url;
};
