package com.scariflabs.horus.terminal

/**
 * One installable guest distribution, pinned like Alpine: a fixed archive,
 * digest, and size, plus the guest probe that must pass before the rootfs is
 * promoted. Nothing here is ever "latest".
 */
data class RootfsCatalogEntry(
  /** Stable distribution key, e.g. "alpine". Stored in v2 records. */
  val distro: String,
  val rootfsId: String,
  /** The distribution's own release string, as the probe reads it. */
  val release: String,
  val url: String,
  val sha256: String,
  val sizeBytes: Long,
  val probeBegin: String,
  val probeEnd: String,
  /** Each check runs one guest executable and must print exactly [ProbeCheck.expected]. */
  val probeChecks: List<ProbeCheck>,
) {
  data class ProbeCheck(val argv: List<String>, val expected: String)

  /** The exact, ordered marker block a passing probe produces and a record stores. */
  val probeMarkers: List<String>
    get() = listOf(probeBegin) + probeChecks.map(ProbeCheck::expected) + probeEnd
}

/** Every distribution Horus can install. Alpine is the default and the only one so far. */
object RootfsCatalog {
  const val DISTRO_ALPINE = "alpine"

  /** Alpine's record shape since 1.0.0; still written for Alpine so downgrades keep working. */
  const val LEGACY_ALPINE_RECORD_SCHEMA = AlpineRootfsCatalog.MANIFEST_SCHEMA_VERSION

  /** Records for every other distribution: adds `distro`, renames `alpineRelease` to `release`. */
  const val RECORD_SCHEMA = 2

  val ALPINE = RootfsCatalogEntry(
    distro = DISTRO_ALPINE,
    rootfsId = AlpineRootfsCatalog.ROOTFS_ID,
    release = AlpineRootfsCatalog.ALPINE_RELEASE,
    url = AlpineRootfsCatalog.ROOTFS_URL,
    sha256 = AlpineRootfsCatalog.ROOTFS_SHA256,
    sizeBytes = AlpineRootfsCatalog.ROOTFS_SIZE_BYTES,
    probeBegin = AlpineRootfsCatalog.ProbeMarkers.BEGIN,
    probeEnd = AlpineRootfsCatalog.ProbeMarkers.END,
    probeChecks = listOf(
      RootfsCatalogEntry.ProbeCheck(listOf("/bin/uname", "-m"), AlpineRootfsCatalog.ProbeMarkers.EXPECTED_ARCH),
      RootfsCatalogEntry.ProbeCheck(listOf("/bin/cat", "/etc/alpine-release"), AlpineRootfsCatalog.ALPINE_RELEASE),
      RootfsCatalogEntry.ProbeCheck(listOf("/bin/sh", "-c", "printf '%s\\n' \"\$HOME\""), AlpineRootfsCatalog.ProbeMarkers.EXPECTED_HOME),
      RootfsCatalogEntry.ProbeCheck(listOf("/bin/sh", "-c", "command -v apk"), AlpineRootfsCatalog.ProbeMarkers.EXPECTED_APK),
      RootfsCatalogEntry.ProbeCheck(listOf("/bin/sh", "-c", "command -v sh"), AlpineRootfsCatalog.ProbeMarkers.EXPECTED_SH),
    ),
  )

  val DEFAULT: RootfsCatalogEntry = ALPINE

  val entries: List<RootfsCatalogEntry> = listOf(ALPINE)

  fun byId(rootfsId: String?): RootfsCatalogEntry? = entries.firstOrNull { it.rootfsId == rootfsId }
}
