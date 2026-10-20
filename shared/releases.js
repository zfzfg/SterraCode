// Only the publisher's stable GitHub releases are executable deployment input.
export const repository = "zfzfg/SterraCode";
export const releaseURL = `https://api.github.com/repos/${repository}/releases/latest`;
export const updaterVersion = "1.0.0";
export const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareVersions(a, b) {
  if (!versionPattern.test(a) || !versionPattern.test(b))
    throw new Error("Invalid release version.");
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function validateRelease(value) {
  if (
    !value ||
    value.schema !== 1 ||
    !versionPattern.test(value.version) ||
    value.protocol !== 1 ||
    !versionPattern.test(value.minUpdaterVersion) ||
    !Array.isArray(value.upgradeFrom) ||
    !value.upgradeFrom.every((v) => versionPattern.test(v)) ||
    !Array.isArray(value.architectures) ||
    !value.architectures.length ||
    !value.architectures.every((v) => ["amd64", "arm64"].includes(v))
  ) {
    throw new Error("Unsupported release metadata.");
  }
  for (const kind of ["app", "runner", "updater"]) {
    if (
      !new RegExp(
        `^ghcr\\.io/zfzfg/sterracode-${kind}@sha256:[a-f0-9]{64}$`,
      ).test(value.images?.[kind])
    ) {
      throw new Error("Untrusted image reference.");
    }
  }
  if (
    !/^[a-f0-9]{64}$/.test(value.packageSHA256) ||
    value.packageURL !==
      `https://github.com/${repository}/releases/download/v${value.version}/installer.zip`
  ) {
    throw new Error("Invalid installation package.");
  }
  return {
    schema: 1,
    version: value.version,
    protocol: 1,
    minUpdaterVersion: value.minUpdaterVersion,
    upgradeFrom: value.upgradeFrom,
    architectures: value.architectures,
    images: value.images,
    packageURL: value.packageURL,
    packageSHA256: value.packageSHA256,
    notesURL: `https://github.com/${repository}/releases/tag/v${value.version}`,
  };
}
export async function latestRelease(fetcher = fetch) {
  const response = await fetcher(releaseURL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "SterraCode-updates",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Release check failed (HTTP ${response.status}).`);
  const release = await response.json();
  if (
    release.draft ||
    release.prerelease ||
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
  )
    throw new Error("No stable release available.");
  const asset = release.assets?.find((a) => a.name === "release.json");
  const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/release.json`;
  if (asset?.browser_download_url !== expected || asset.size > 65536)
    throw new Error("Release metadata missing.");
  const metadata = await fetcher(expected, {
    signal: AbortSignal.timeout(15000),
  });
  if (
    !metadata.ok ||
    Number(metadata.headers.get("content-length") || 0) > 65536
  )
    throw new Error("Release metadata unavailable.");
  const content = await metadata.text();
  if (content.length > 65536) throw new Error("Release metadata too large.");
  const value = validateRelease(JSON.parse(content));
  if (`v${value.version}` !== release.tag_name)
    throw new Error("Release version mismatch.");
  return value;
}
export function updateAllowed(current, release, arch) {
  return (
    compareVersions(release.version, current) > 0 &&
    release.architectures.includes(arch) &&
    release.upgradeFrom.includes(current) &&
    compareVersions(updaterVersion, release.minUpdaterVersion) >= 0
  );
}
