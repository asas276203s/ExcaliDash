/**
 * Copy to clipboard with a fallback.
 *
 * `navigator.clipboard` is unavailable on insecure origins and can be denied
 * outright by the browser, so fall back to the old execCommand path rather
 * than silently doing nothing.
 */
export const copyText = async (text: string): Promise<boolean> => {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
};
