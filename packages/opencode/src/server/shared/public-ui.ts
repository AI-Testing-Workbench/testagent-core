// Static UI assets the browser fetches without app-managed credentials, e.g.
// the manifest link in <head>. These bypass auth so the page can install/render
// the manifest icons even when a server password is configured.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

// testagent_change start
// Static shell assets the browser loads automatically without app-managed
// credentials (script/style/favicon requests do not carry `?auth_token=`). If
// these return 401 the browser shows a native Basic auth prompt even when the
// document was opened with a valid auth_token link. The API stays protected;
// only these public, data-free UI files bypass auth.
function isPublicUIAsset(pathname: string) {
  if (pathname.startsWith("/assets/")) return true
  if (pathname.startsWith("/favicon")) return true
  if (pathname.startsWith("/apple-touch-icon")) return true
  if (pathname === "/index.html") return true
  if (pathname === "/oc-theme-preload.js") return true
  return false
}
// testagent_change end

export function isPublicUIPath(method: string, pathname: string) {
  if (method !== "GET") return false
  if (PUBLIC_UI_PATHS.has(pathname)) return true
  return isPublicUIAsset(pathname) // testagent_change
}
