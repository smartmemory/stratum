import { PINNED_APP_SERVER_VERSION } from "./codex-appserver-protocol/pinned-version.js";

export const SUPPORTED_APP_SERVER_VERSIONS: readonly string[] = Object.freeze([PINNED_APP_SERVER_VERSION]);

/** The observed initialize identity carries the CLI version after the first slash.
 * This gates known versions, not schema changes within a version. No runtime generation. */
export function assertAppServerIdentity(userAgent: string, clientInfo: { name: string; version: string }): string {
  const version = SUPPORTED_APP_SERVER_VERSIONS.find(version => {
    const prefix = `${clientInfo.name}/${version} (`;
    const suffix = ` (${clientInfo.name}; ${clientInfo.version})`;
    return typeof userAgent === "string" && !/[\u0000-\u001f\u007f-\u009f]/u.test(userAgent)
      && userAgent.startsWith(prefix) && userAgent.endsWith(suffix)
      && userAgent.length > prefix.length + suffix.length;
  });
  if (!version) {
    throw new Error("Unsupported Codex app-server initialize identity; expected a pinned userAgent version and matching clientInfo");
  }
  return version;
}
