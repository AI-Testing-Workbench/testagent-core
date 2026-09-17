// testagent_change - unified envelope for api_intel responses.
// All actions return one of these shapes so the agent never sees an uncaught exception.

export type PlatformId = "apicol" | "fa"

export type Envelope<T> =
  | { ok: true; platform: PlatformId; route?: string; data: T; hint?: string }
  | { ok: false; platform: PlatformId; route?: string; error: string; hint?: string }

export function ok<T>(platform: PlatformId, data: T, route?: string): Envelope<T> {
  const e: { ok: true; platform: PlatformId; data: T; route?: string } = {
    ok: true,
    platform,
    data,
  }
  if (route) e.route = route
  return e
}

export function fail(
  platform: PlatformId,
  error: string,
  opts?: { route?: string; hint?: string },
): Envelope<never> {
  const e: { ok: false; platform: PlatformId; error: string; route?: string; hint?: string } = {
    ok: false,
    platform,
    error,
  }
  if (opts?.route) e.route = opts.route
  if (opts?.hint) e.hint = opts.hint
  return e
}