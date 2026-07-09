declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const TESTAGENT_VERSION: string
}

// testagent_change: hardcode version because Bun build define doesn't
// reliably replace TESTAGENT_VERSION in workspace dependency packages.
// The define in build.ts / build-node.ts is kept as a secondary mechanism
// for other build targets that may support it.
export const InstallationVersion = typeof TESTAGENT_VERSION === "string" ? TESTAGENT_VERSION : "1.3.0"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "latest"
export const InstallationLocal = InstallationChannel === "local"
