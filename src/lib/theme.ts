/**
 * Theme resolution (system update — Group 3).
 *
 * The reported bug: the app flipped from light to dark after ordinary button
 * clicks. Root cause was persistence — the choice lived only in localStorage and
 * the OS preference was consulted as a live fallback, so any FULL document load
 * (filter form submits, the `window.location.reload()` after generate /
 * finalize / publish / assignment save) re-evaluated `prefers-color-scheme`
 * whenever storage was empty or unavailable in that context.
 *
 * Fix: one shared resolution order, and the resolved value is LATCHED into both
 * the cookie and localStorage the first time it is computed. After that the OS
 * preference is never consulted again, so the theme can only change when the
 * user changes it. The cookie is also read server-side by the root layout, so
 * SSR and client agree and there is no flash.
 *
 * Purely presentational — no application state, no security implication.
 */

export const THEME_COOKIE = "pnk-theme";
export const THEME_STORAGE_KEY = "pnk-theme";
export type Theme = "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** Precedence: explicit cookie → explicit stored choice → OS preference → light. */
export function resolveTheme(input: {
  cookie?: string | null;
  stored?: string | null;
  prefersDark?: boolean;
}): Theme {
  if (isTheme(input.cookie)) return input.cookie;
  if (isTheme(input.stored)) return input.stored;
  return input.prefersDark ? "dark" : "light";
}

/**
 * Applied before first paint. Reads the cookie first (server-visible, survives
 * partitioned/ephemeral storage), then localStorage, then the OS preference —
 * and writes the resolved value back to BOTH so the theme is stable from then
 * on. Falls back to the server-rendered `data-theme` if anything throws.
 */
export const THEME_BOOTSTRAP =
  "(function(){try{" +
  "var m=document.cookie.match(/(?:^|; )pnk-theme=(light|dark)/);" +
  "var c=m&&m[1]?m[1]:null;" +
  "var s=null;try{s=localStorage.getItem('pnk-theme');}catch(e){}" +
  "var v=function(x){return x==='dark'||x==='light';};" +
  "var t=v(c)?c:(v(s)?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));" +
  "document.documentElement.dataset.theme=t;" +
  "try{document.cookie='pnk-theme='+t+';path=/;max-age=31536000;samesite=lax';}catch(e){}" +
  "try{localStorage.setItem('pnk-theme',t);}catch(e){}" +
  "}catch(e){}})();";
