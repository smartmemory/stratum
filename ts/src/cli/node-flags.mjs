export function extraNodeFlags() {
  return process.allowedNodeEnvironmentFlags.has("--experimental-transform-types")
    ? ["--experimental-transform-types"]
    : [];
}
