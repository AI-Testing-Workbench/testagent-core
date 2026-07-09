declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const TESTAGENT_VERSION: string
}

export const InstallationVersion = typeof TESTAGENT_VERSION === "string" ? TESTAGENT_VERSION : "1.14.42"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "latest"
export const InstallationLocal = InstallationChannel === "local"
