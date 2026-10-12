package com.scariflabs.horus.terminal

import java.io.File
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Rootfs state-machine coverage with injected downloader/extractor/prober
 * fakes (bad digest, interrupted extraction,
 * repeat install, reset semantics, half-written active record).
 */
class DistroStoreCoreTest {
  @get:Rule
  val temp = TemporaryFolder()

  private val archiveBytes = ByteArray(4096) { (it % 251).toByte() }
  private val archiveSha256 = sha256(archiveBytes)

  private class FakeDownloader(private val bytes: ByteArray, private val failWith: IOException? = null) : DistroStoreCore.ArchiveDownloader {
    var calls = 0
    override fun download(url: String, expectedBytes: Long, destination: File, timeoutMs: Long): Long {
      calls++
      failWith?.let { throw it }
      destination.writeBytes(bytes)
      return bytes.size.toLong()
    }
  }

  private class FakeExtractor(private val failWith: Exception? = null) : DistroStoreCore.RootfsExtractor {
    var calls = 0
    var lastFormat: ArchiveFormat? = null
    override fun extract(archive: File, destinationRoot: File, format: ArchiveFormat): SafeTarExtractor.Summary {
      calls++
      lastFormat = format
      failWith?.let { throw it }
      File(destinationRoot, "etc").mkdirs()
      File(destinationRoot, "etc/alpine-release").writeText("3.24.0\n")
      return SafeTarExtractor.Summary(2, 1, 1, 0, 0, emptyList(), 12)
    }
  }

  private class FakeProber(private val result: GuestProbeResult? = null) : GuestProber {
    var calls = 0
    override fun probe(rootfsDir: File, guestHomeDir: File, timeoutMs: Long, entry: RootfsCatalogEntry): GuestProbeResult {
      calls++
      result?.let { return it }
      return GuestProbeResult(exitCode = 0, output = entry.probeMarkers.joinToString("\n"), durationMs = 5)
    }
  }

  private fun newStore(
    downloader: DistroStoreCore.ArchiveDownloader = FakeDownloader(archiveBytes),
    extractor: DistroStoreCore.RootfsExtractor = FakeExtractor(),
    prober: GuestProber = FakeProber(),
  ): DistroStoreCore = DistroStoreCore(
    paths = DistroStorePaths(File(temp.root, "horus")),
    downloader = downloader,
    extractor = extractor,
    prober = prober,
  )

  private fun installParams() = Triple(
    AlpineRootfsCatalog.ROOTFS_ID,
    archiveSha256,
    archiveBytes.size.toLong(),
  )

  @Test
  fun `happy path installs verifies probes and writes the active record`() {
    val store = newStore()
    // Pre-create a home sentinel: installs must never touch user data.
    store.storage.home.mkdirs()
    val sentinel = File(store.storage.home, "keepme.txt")
    sentinel.writeText("home data")

    val outcome = store.install(rootfsId = installParams().first, expectedSha256 = installParams().second, expectedBytes = installParams().third)
    assertTrue(outcome.toString(), outcome is DistroStoreCore.InstallOutcome.Success)
    val active = store.readActiveRecord()
    assertNotNull(active)
    assertEquals(AlpineRootfsCatalog.ROOTFS_ID, active!!.rootfsId)
    assertEquals(RootfsCatalog.DISTRO_ALPINE, active.distro)
    assertEquals("3.24.0", active.release)
    assertEquals(archiveSha256, active.rootfsSha256)
    assertEquals(AlpineRootfsCatalog.MANIFEST_SCHEMA_VERSION, active.schemaVersion)
    assertTrue(active.probeMarkers.contains("aarch64"))
    assertEquals(listOf(AlpineRootfsCatalog.ROOTFS_ID), store.installedVersionIds())
    assertTrue(store.activeRootfsDir()!!.resolve("etc/alpine-release").isFile)
    // The verified archive moved into the cache; incoming is empty.
    assertTrue(store.storage.archiveInCache(AlpineRootfsCatalog.ROOTFS_ID).isFile)
    assertFalse(store.storage.archiveInIncoming(AlpineRootfsCatalog.ROOTFS_ID).exists())
    // User data survived untouched.
    assertEquals("home data", sentinel.readText())
  }

  @Test
  fun `the extractor decompresses with the catalog entry's archive format`() {
    val gzip = FakeExtractor()
    newStore(extractor = gzip).install(rootfsId = installParams().first, expectedSha256 = installParams().second, expectedBytes = installParams().third)
    assertEquals(ArchiveFormat.TAR_GZ, gzip.lastFormat)

    val xz = FakeExtractor()
    newStore(extractor = xz).install(
      entry = RootfsCatalog.ALPINE.copy(archiveFormat = ArchiveFormat.TAR_XZ),
      expectedSha256 = installParams().second,
      expectedBytes = installParams().third,
    )
    assertEquals(ArchiveFormat.TAR_XZ, xz.lastFormat)
  }

  @Test
  fun `a bad digest leaves no active rootfs and no leftover archive`() {
    val wrongBytes = ByteArray(4096) { (it % 249).toByte() }
    val store = newStore(downloader = FakeDownloader(wrongBytes))
    val outcome = store.install(expectedSha256 = archiveSha256, expectedBytes = wrongBytes.size.toLong())
    assertTrue(outcome is DistroStoreCore.InstallOutcome.Failure)
    assertEquals("digest_mismatch", (outcome as DistroStoreCore.InstallOutcome.Failure).reasonCode)
    assertNull(store.readActiveRecord())
    assertFalse(store.storage.archiveInIncoming(AlpineRootfsCatalog.ROOTFS_ID).exists())
    assertFalse(store.storage.archiveInCache(AlpineRootfsCatalog.ROOTFS_ID).exists())
    assertTrue(store.installedVersionIds().isEmpty())
  }

  @Test
  fun `a size mismatch and a transport failure fail closed`() {
    val shortDownloader = FakeDownloader(archiveBytes.copyOf(1024))
    val short = newStore(downloader = shortDownloader).install(
      expectedSha256 = archiveSha256,
      expectedBytes = archiveBytes.size.toLong(),
    )
    assertEquals("size_mismatch", (short as DistroStoreCore.InstallOutcome.Failure).reasonCode)

    val failing = newStore(downloader = FakeDownloader(archiveBytes, failWith = IOException("network down")))
      .install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertEquals("download_failed", (failing as DistroStoreCore.InstallOutcome.Failure).reasonCode)
  }

  @Test
  fun `an imported archive uses the given source and the same digest check`() {
    val network = FakeDownloader(archiveBytes, failWith = IOException("network down"))
    val store = newStore(downloader = network)

    val wrongFile = FakeDownloader(ByteArray(4096) { (it % 249).toByte() })
    val rejected = store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong(), source = wrongFile)
    assertEquals("digest_mismatch", (rejected as DistroStoreCore.InstallOutcome.Failure).reasonCode)
    assertNull(store.readActiveRecord())

    val pickedFile = FakeDownloader(archiveBytes)
    val outcome = store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong(), source = pickedFile)
    assertTrue(outcome.toString(), outcome is DistroStoreCore.InstallOutcome.Success)
    assertEquals(1, pickedFile.calls)
    assertEquals(0, network.calls)
    assertEquals(archiveSha256, store.readActiveRecord()!!.rootfsSha256)
  }

  @Test
  fun `an interrupted extraction leaves the previous active version intact`() {
    val store = newStore()
    val first = store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertTrue(first is DistroStoreCore.InstallOutcome.Success)
    val activeBefore = store.readActiveRecord()

    val interrupted = newStore(
      downloader = FakeDownloader(archiveBytes),
      extractor = FakeExtractor(failWith = IOException("simulated interruption mid-extraction")),
    ).install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertEquals("extraction_failed", (interrupted as DistroStoreCore.InstallOutcome.Failure).reasonCode)

    // The interrupted attempt shares the paths object family, so verify the
    // original active record and rootfs are still authoritative.
    assertEquals(activeBefore, store.readActiveRecord())
    assertTrue(store.activeRootfsDir()!!.resolve("etc/alpine-release").isFile)
    assertFalse(store.storage.versionStaging(AlpineRootfsCatalog.ROOTFS_ID).exists())
  }

  @Test
  fun `a probe with missing markers is never promoted`() {
    val badProbe = GuestProbeResult(exitCode = 0, output = "alpine_probe_begin\nx86_64\n", durationMs = 3)
    val store = newStore(prober = FakeProber(badProbe))
    val outcome = store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertEquals("probe_markers_missing", (outcome as DistroStoreCore.InstallOutcome.Failure).reasonCode)
    assertNull(store.readActiveRecord())
    assertFalse(store.storage.versionStaging(AlpineRootfsCatalog.ROOTFS_ID).exists())
  }

  @Test
  fun `a repeated install reuses the cached archive and stays consistent`() {
    val downloader = FakeDownloader(archiveBytes)
    val store = newStore(downloader = downloader)
    val first = store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertTrue(first is DistroStoreCore.InstallOutcome.Success)
    assertFalse((first as DistroStoreCore.InstallOutcome.Success).reusedCachedArchive)

    val second = store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertTrue(second is DistroStoreCore.InstallOutcome.Success)
    assertTrue((second as DistroStoreCore.InstallOutcome.Success).reusedCachedArchive)
    assertEquals(1, downloader.calls)
    assertEquals(listOf(AlpineRootfsCatalog.ROOTFS_ID), store.installedVersionIds())
    assertEquals(1, store.installedVersionIds().size)
    assertNotNull(store.readActiveRecord())
  }

  @Test
  fun `an alpine install keeps writing the v1 record an older horus can read`() {
    val store = newStore()
    store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    for (record in listOf(store.storage.activeRecord, store.storage.versionManifest(AlpineRootfsCatalog.ROOTFS_ID))) {
      val json = org.json.JSONObject(record.readText())
      assertEquals(1, json.getInt("schemaVersion"))
      assertEquals("3.24.0", json.getString("alpineRelease"))
      assertFalse(json.has("distro"))
      assertFalse(json.has("release"))
    }
  }

  @Test
  fun `an active record written by horus 1_0_4 still reads as the active alpine rootfs`() {
    val store = newStore()
    store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    // The exact shape 1.0.4 wrote, so an upgrade never sees "not installed".
    val legacy = """{"schemaVersion":1,"rootfsId":"alpine-3.24.0-aarch64","alpineRelease":"3.24.0",""" +
      """"rootfsSha256":"$archiveSha256","installedAtIso":"2026-10-01T10:00:00Z","probeMarkers":""" +
      """["alpine_probe_begin","aarch64","3.24.0","/root","/sbin/apk","/bin/sh","alpine_probe_end"]}"""
    store.storage.activeRecord.writeText(legacy)
    store.storage.versionManifest(AlpineRootfsCatalog.ROOTFS_ID).writeText(legacy)

    val active = store.readActiveRecord()
    assertNotNull(active)
    assertEquals(RootfsCatalog.DISTRO_ALPINE, active!!.distro)
    assertEquals("3.24.0", active.release)
    assertEquals(listOf(AlpineRootfsCatalog.ROOTFS_ID), store.installedVersionIds())
  }

  @Test
  fun `records that do not match their catalog entry read as not installed`() {
    val store = newStore()
    store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    val markers = """["alpine_probe_begin","aarch64","3.24.0","/root","/sbin/apk","/bin/sh","alpine_probe_end"]"""
    val base = """"rootfsId":"alpine-3.24.0-aarch64","rootfsSha256":"$archiveSha256",""" +
      """"installedAtIso":"2026-10-01T10:00:00Z","probeMarkers":$markers"""
    val mismatched = listOf(
      // Alpine must stay on the v1 shape.
      """{"schemaVersion":2,"distro":"alpine","release":"3.24.0",$base}""",
      // A v1 record is always Alpine, so its release must be Alpine's.
      """{"schemaVersion":1,"alpineRelease":"3.23.0",$base}""",
      // An id the catalog does not know.
      """{"schemaVersion":2,"distro":"debian","release":"13",""" + base.replace("alpine-3.24.0-aarch64", "debian-13-aarch64") + "}",
    )
    for (json in mismatched) {
      store.storage.activeRecord.writeText(json)
      assertNull(json, store.readActiveRecord())
    }
  }

  @Test
  fun `a debian install writes a v2 record and leaves alpine installed beside it`() {
    val store = newStore()
    store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    val outcome = store.install(entry = RootfsCatalog.DEBIAN, expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertTrue(outcome.toString(), outcome is DistroStoreCore.InstallOutcome.Success)

    val json = org.json.JSONObject(store.storage.activeRecord.readText())
    assertEquals(RootfsCatalog.RECORD_SCHEMA, json.getInt("schemaVersion"))
    assertEquals("debian", json.getString("distro"))
    assertEquals("13.7", json.getString("release"))
    assertFalse(json.has("alpineRelease"))

    val active = store.readActiveRecord()
    assertNotNull(active)
    assertEquals(RootfsCatalog.DEBIAN.rootfsId, active!!.rootfsId)
    assertEquals(RootfsCatalog.DISTRO_DEBIAN, active.distro)
    assertEquals(RootfsCatalog.DEBIAN.probeMarkers, active.probeMarkers)
    assertEquals(
      setOf(AlpineRootfsCatalog.ROOTFS_ID, RootfsCatalog.DEBIAN.rootfsId),
      store.installedVersionIds().toSet(),
    )
  }

  @Test
  fun `a debian rootfs that probes like alpine is never promoted`() {
    val alpineProbe = GuestProbeResult(exitCode = 0, output = RootfsCatalog.ALPINE.probeMarkers.joinToString("\n"), durationMs = 5)
    val store = newStore(prober = FakeProber(alpineProbe))
    val outcome = store.install(entry = RootfsCatalog.DEBIAN, expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertTrue(outcome.toString(), outcome is DistroStoreCore.InstallOutcome.Failure)
    assertNull(store.readActiveRecord())
  }

  @Test
  fun `the catalog pins every entry to a distinct id digest and marker block`() {
    val entries = RootfsCatalog.entries
    assertEquals(RootfsCatalog.ALPINE, RootfsCatalog.DEFAULT)
    assertEquals(entries.size, entries.map { it.rootfsId }.toSet().size)
    assertEquals(entries.size, entries.map { it.sha256 }.toSet().size)
    assertEquals(entries.size, entries.map { it.probeBegin }.toSet().size)
    for (entry in entries) {
      assertTrue(entry.rootfsId, AlpineRootfsCatalog.isValidRootfsId(entry.rootfsId))
      assertTrue(entry.rootfsId, Regex("^[a-f0-9]{64}$").matches(entry.sha256))
      assertTrue(entry.rootfsId, entry.url.startsWith("https://"))
      assertEquals(entry, RootfsCatalog.byId(entry.rootfsId))
    }
    assertEquals(ArchiveFormat.TAR_XZ, RootfsCatalog.DEBIAN.archiveFormat)
  }

  @Test
  fun `a half-written active record reads as not installed`() {
    val store = newStore()
    store.storage.distro.mkdirs()
    store.storage.activeRecord.writeText("{\"schemaVersion\":1,\"rootfsId\":\"alpine-3.24")
    assertNull(store.readActiveRecord())
    store.storage.activeRecord.writeText("{\"schemaVersion\":9,\"rootfsId\":\"alpine-3.24.0-aarch64\"}")
    assertNull(store.readActiveRecord())
  }

  @Test
  fun `reset removes only the rootfs scope and never home silently`() {
    val store = newStore()
    store.install(expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    val homeSentinel = File(store.storage.home, "credential-store.txt").apply {
      parentFile!!.mkdirs()
      writeText("user data")
    }
    val harnessCredential = File(store.storage.harnessHome(TerminalRuntimeContract.TOOLCHAIN_TARGET_CODEX), "auth.json").apply {
      parentFile!!.mkdirs()
      writeText("harness data")
    }
    val workspaceSentinel = File(store.storage.defaultWorkspace, "repo.txt").apply {
      parentFile!!.mkdirs()
      writeText("workspace data")
    }

    val rootfsReset = store.reset()
    assertEquals(listOf(AlpineRootfsCatalog.ROOTFS_ID), rootfsReset.removedVersionIds)
    assertFalse(rootfsReset.homeRemoved)
    assertFalse(rootfsReset.workspacesRemoved)
    assertNull(store.readActiveRecord())
    assertTrue(store.installedVersionIds().isEmpty())
    assertEquals("user data", homeSentinel.readText())
    assertEquals("harness data", harnessCredential.readText())
    assertEquals("workspace data", workspaceSentinel.readText())

    val userReset = store.reset(deleteHome = true, deleteWorkspaces = true)
    assertTrue(userReset.homeRemoved)
    assertTrue(userReset.workspacesRemoved)
    assertFalse(homeSentinel.exists())
    assertFalse(harnessCredential.exists())
    assertFalse(workspaceSentinel.exists())
    assertTrue(store.storage.home.isDirectory)
    for (harness in listOf(
      TerminalRuntimeContract.TOOLCHAIN_TARGET_CLAUDE,
      TerminalRuntimeContract.TOOLCHAIN_TARGET_CODEX,
      TerminalRuntimeContract.TOOLCHAIN_TARGET_OPENCODE,
    )) {
      assertTrue(store.storage.harnessHome(harness).isDirectory)
    }
  }

  @Test
  fun `reset can remove home and workspace independently`() {
    val store = newStore()
    val homeSentinel = File(store.storage.home, "home-only.txt").apply {
      parentFile!!.mkdirs()
      writeText("home")
    }
    val workspaceSentinel = File(store.storage.defaultWorkspace, "workspace-only.txt").apply {
      parentFile!!.mkdirs()
      writeText("workspace")
    }

    val homeReset = store.reset(deleteHome = true)
    assertTrue(homeReset.homeRemoved)
    assertFalse(homeReset.workspacesRemoved)
    assertFalse(homeSentinel.exists())
    assertEquals("workspace", workspaceSentinel.readText())
    assertTrue(store.storage.harnessHome(TerminalRuntimeContract.TOOLCHAIN_TARGET_CLAUDE).isDirectory)

    val workspaceReset = store.reset(deleteWorkspaces = true)
    assertFalse(workspaceReset.homeRemoved)
    assertTrue(workspaceReset.workspacesRemoved)
    assertFalse(workspaceSentinel.exists())
    assertTrue(store.storage.home.isDirectory)
    assertTrue(store.storage.defaultWorkspace.isDirectory)
  }

  @Test
  fun `invalid catalog inputs are rejected before any io`() {
    val store = newStore(downloader = FakeDownloader(archiveBytes).also { it.calls = 0 })
    val badId = store.install(rootfsId = "../escape", expectedSha256 = archiveSha256, expectedBytes = archiveBytes.size.toLong())
    assertEquals("invalid_rootfs_id", (badId as DistroStoreCore.InstallOutcome.Failure).reasonCode)
    val badDigest = store.install(expectedSha256 = "zz", expectedBytes = archiveBytes.size.toLong())
    assertEquals("invalid_digest", (badDigest as DistroStoreCore.InstallOutcome.Failure).reasonCode)
  }

  @Test
  fun `probe validation requires one exact marker block and guards host path boundaries`() {
    val valid = GuestProbeResult(
      exitCode = 0,
      output = "warning before /data/user/0/com.scariflabs.horus/files/horus/tmp\n" + listOf(
        "alpine_probe_begin",
        "aarch64",
        "3.24.0",
        "/root",
        "/sbin/apk",
        "/bin/sh",
        "alpine_probe_end",
      ).joinToString("\n") + "\nwarning after",
      durationMs = 1,
    )
    assertTrue(valid.hasAllExpectedMarkers())
    assertEquals(7, valid.markerLines().size)
    assertTrue(valid.leaksHostPath("/data/user/0/com.scariflabs.horus/files/horus"))
    assertTrue(valid.leaksHostPath("/data/user/0/com.scariflabs.horus/files/horus/tmp"))
    assertFalse(valid.leaksHostPath("/data/user/0/com.scariflabs.horus/files/horuslot"))

    val extraLine = valid.copy(output = valid.output.replace("aarch64\n", "aarch64-extra\n"))
    assertFalse(extraLine.hasAllExpectedMarkers())
    val reordered = valid.copy(output = valid.output.replace("/bin/sh\n", "alpine_probe_end\n/bin/sh\n"))
    assertFalse(reordered.hasAllExpectedMarkers())
  }

  companion object {
    private fun sha256(bytes: ByteArray): String =
      java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
  }
}
