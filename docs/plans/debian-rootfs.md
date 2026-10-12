# Plan: Debian as a second Linux distribution

Tracking: [#3](https://github.com/scarif-labs/horus/issues/3)

## Goal

Let users pick Debian instead of Alpine. Alpine uses musl, and a lot of
prebuilt tools assume glibc (some pip wheels, prebuilt CLIs, language
toolchains). Debian gives glibc and the apt archive.

Ground rules:

- Alpine stays the default. A user who never touches the new setting sees no
  change: same rootfs id, same `active.json`, same scripts.
- Debian is opt-in and labelled experimental for the first release.
- Switching distros never deletes home, workspaces, or the other distro.

## What exists today

| Area | State | Alpine-specific? |
| --- | --- | --- |
| Storage (`DistroStoreCore`, `DistroStorePaths`) | Each rootfs lives in `distro/versions/<id>/`, `active.json` picks one, install is staged and atomic | Only the record checks (below) |
| Catalog (`AlpineRootfsCatalog`) | One pinned entry: id, URL, sha256, size, release, probe | Yes |
| Records (`readRecordFile`, `isValidRecord`) | Reject anything whose `alpineRelease` is not `3.24.0` or whose probe markers differ | Yes |
| JS contract (`src/terminal/distroContract.ts`) | `activeRootfsId === PINNED_ROOTFS_ID`, pinned digest, pinned markers | Yes |
| Extractor (`SafeTarExtractor`, was `SafeTarGzExtractor`) | gzip and xz, picked by the catalog entry | No |
| PRoot (`ProotSessionLauncher`) | `-0`, `--link2symlink`, home/workspace binds | No; this is what dpkg needs too |
| Provisioning script (`ProotSessionLauncher` ~L1110-1640) | ~10 `apk add` calls: shell, gh, Claude, Codex/OpenCode, procps, remote access, agent installer; `/etc/apk/repositories` mirror rewrite | Yes |
| Probe (`ProotGuestProber`) | `/etc/alpine-release`, `/sbin/apk` | Yes |
| Download sources (`DownloadSources`, `downloadSources.ts`) | `alpineMirror`, `npmRegistry` | Mirror is Alpine-only |
| Homes | `home/` and `harness-homes/*` are bind-mounted into whatever rootfs runs | See risk below |

### The one real compatibility risk: shared home

Harness installs and their "ready" markers live in the bind-mounted home:
`~/.local` (Claude Code's `linux-arm64-musl` binary, Codex's musl native npm
package, OpenCode) and `~/.cache/horus/<target>.ready`. If Debian mounted the
same home, it would see `claude.ready`, skip the install, and run a musl binary
on glibc. Going back to Alpine after a Debian install would hit the opposite
problem.

**Decision: per-distro tool state, shared user data.** Keep `home/` as Alpine's
home (no migration for existing users). Give Debian its own `homes/debian/`
for `~/.local` and `~/.cache/horus`, and bind the shared bits that are about the
user rather than the libc (`~/.ssh`, `~/.gitconfig`, `~/.config/gh`, harness
auth/config under `harness-homes/`). Workspaces are shared as-is.

Simpler fallback if the selective binds get messy: fully separate home per
distro, shared workspaces only. Users then sign in to gh/harnesses once per
distro.

## Phases

### Phase 1: Generalise the catalog (no user-visible change)

1. Replace `AlpineRootfsCatalog` with a `RootfsCatalog` holding entries:
   `distro` (`alpine` | `debian`), `rootfsId`, `release`, `url`, `sha256`,
   `sizeBytes`, `archiveFormat` (`tar.gz` | `tar.xz`), probe command and
   expected markers, package manager (`apk` | `apt`).
   Alpine's entry keeps today's values exactly.
2. Records:
   - Alpine records keep being written as schema v1 (`alpineRelease`), byte for
     byte, so a downgrade to 1.0.x still reads them.
   - Non-Alpine records use schema v2 (`distro`, `release`).
   - `readRecordFile` accepts v1 (as Alpine) and v2; validation looks up the
     catalog entry by `rootfsId` instead of comparing to one constant.
3. `install()` takes a catalog entry instead of loose Alpine defaults.
4. JS: `distroContract.ts` validates against a catalog list mirrored from
   native (ids, digests, markers), and `getRuntimeStatus` gains
   `activeDistro` / `activeRelease`. Keep `activeAlpineRelease` populated for
   Alpine so nothing downstream breaks.
5. Tests: existing `DistroStoreCoreTest` cases pass unchanged; add one that a
   real v1 `active.json` from 1.0.4 still reads as active, and one that a v2
   record round-trips.

Ship-safe on its own. **Estimate: ~1 day.**

### Phase 2: xz archives

1. Add `org.tukaani:xz` (pure Java, 0BSD since 1.10; fine for F-Droid) and let
   the extractor pick the decompressor from the catalog's `archiveFormat`.
2. Keep every existing safety check (path traversal, symlink escape, device
   nodes, size caps). Debian's rootfs has more hardlinks and device entries
   than Alpine's minirootfs; check how `--link2symlink` and the extractor
   handle them.
3. Tests: a small fixture `.tar.xz` with the same unsafe-entry cases as the
   gzip tests.

**Estimate: ~0.5 day.**

### Phase 3: Debian rootfs and probe

1. Source: the official debuerreotype builds
   (`docker-debian-artifacts`, branch `dist-arm64v8`, `trixie/slim`). They
   are built from Debian's own archive and are reproducible.
   Checked 2026-10-12: that branch now ships `oci/blobs/rootfs.tar.gz`
   (30.2 MB, gzip; the old `rootfs.tar.xz` is gone), and its sha256 equals the
   OCI layer digest of `arm64v8/debian:trixie-slim`. But every build is one
   commit that replaces the previous one (the branch is force-pushed), so a
   commit-pinned raw URL can stop resolving once a newer build lands. So the
   pinned URL points at a Horus GitHub release asset: the same tarball,
   recompressed to `.tar.xz` (17.6 MB), with the upstream layer digest
   recorded next to it so anyone can check it against Docker Hub.
   Both formats of the 13.7 build extract cleanly with `SafeTarExtractor`:
   3,266 entries, 1 hardlink, no device nodes, 98 MiB unpacked.
   Published 2026-10-12 as release `rootfs-debian-13.7-20261005`:
   `debian-trixie-slim-13.7-arm64.tar.xz`, 17,386,584 bytes, sha256
   `c4a40504d8eddd7d47125d129296352d3758b1d0ce958bd517b44631aee74eb5`,
   built with `gunzip -c rootfs.tar.gz | xz -6 -T1` (XZ Utils 5.8.3,
   byte-identical on rerun). Catalog id: `debian-13.7-20261005-aarch64`; the
   build date is in the id because Debian rebuilds a point release with
   security fixes.
2. Size: ~18 MB download (xz) vs ~4 MB for Alpine. Show it in the picker.
3. Probe: `uname -m`, `/etc/debian_version`, `$HOME`, `command -v apt-get`,
   `command -v sh`, wrapped in `debian_probe_begin` / `debian_probe_end`.
   Debian is merged-usr, so the checks run `/usr/bin/*` and expect
   `/usr/bin/apt-get` and `/usr/bin/sh` under the prober's PATH.
   `DebianRootfsDeviceTest` passed on the Redmi Note 10 Pro (Android 16)
   on 2026-10-12: download, extraction, and probe in 14.5 s beside Alpine.
   It also confirmed `dpkg --print-architecture` is `arm64`, glibc's
   `/lib/ld-linux-aarch64.so.1` exists, and apt uses deb822
   `/etc/apt/sources.list.d/debian.sources`.
4. First-boot fix-ups inside the rootfs (run once, as root):
   - `/etc/apt/apt.conf.d/99horus`: `APT::Sandbox::User "root";` (apt cannot
     drop to `_apt` under PRoot), `Acquire::Retries "3"`,
     `Dpkg::Use-Pty "0"`.
   - `/etc/dpkg/dpkg.cfg.d/99horus`: skip docs/man/locales to save space
     (optional; matches Alpine's footprint better).
   - `DEBIAN_FRONTEND=noninteractive` for every provisioning call.
   - `/etc/resolv.conf` and `/etc/hosts` the same way Alpine gets them.

**Estimate: ~1 day, mostly on-device trial and error.**

### Phase 4: Package-manager abstraction in the provisioning script

1. Add `pkg_install` / `pkg_ready` shell functions to the provisioning script.
   They dispatch on the package manager the catalog passes in
   (`HORUS_PKG=apk|apt`). `apt` runs `apt-get update` once per boot, guarded
   by a stamp file, then `apt-get install -y --no-install-recommends`.
2. Package map (Alpine → Debian):

   | Use | Alpine | Debian |
   | --- | --- | --- |
   | shell base | `ca-certificates curl gcompat git jq less openssh-client-default python3 ripgrep tzdata zsh` | `ca-certificates curl git jq less openssh-client python3 ripgrep tzdata zsh` (no gcompat needed) |
   | gh | `github-cli` | `gh` |
   | Claude | `bash curl … libgcc libstdc++` | `bash curl ca-certificates git openssh-client zsh` |
   | Codex/OpenCode | `nodejs npm …` | `nodejs npm …` (trixie ships Node 20; confirm Codex/OpenCode minimums) |
   | ps/top | `procps-ng` | `procps` |
   | remote access | `dropbear openssh-client-default openssh-sftp-server rsync zsh` | `dropbear-bin openssh-client openssh-sftp-server rsync zsh` |

3. Path checks in the script that assume Alpine layouts need a Debian
   variant: `/lib/ld-linux-aarch64.so.1` (Alpine's gcompat shim; native on
   Debian), `/usr/lib/ssh/sftp-server` (Debian:
   `/usr/lib/openssh/sftp-server`), `/sbin/apk`.
4. Claude Code installer: pick `linux-arm64` (glibc) instead of
   `linux-arm64-musl` on Debian. `claude_download_kb` already reads the arch;
   add libc. The npm size helper already detects libc.
5. Mirror: rename the `alpineMirror` source to a per-distro mirror setting
   (`debianMirror` rewrites `/etc/apt/sources.list.d/debian.sources`). Keep
   the stored `alpineMirror` key so existing settings carry over.
6. Agent prompts that say "`apk add` will not work" become
   distro-neutral ("the package manager").
7. Wire per-distro tool state (`homes/debian` binds) from the risk section.

**Estimate: ~1.5–2 days.** The script is long and every branch needs a run.

### Phase 5: UI

1. Onboarding: "Linux distribution" step with two cards. Alpine (default,
   ~4 MB, "small and fast") and Debian (experimental, ~18 MB, "glibc, wider
   tool support").
2. Settings: same choice. Switching installs the other rootfs if needed, then
   flips `active.json`. Both stay on disk. Show size used per distro, with a
   "remove" action for the inactive one.
3. Copy that names Alpine at runtime ("Alpine shell install starting…",
   "Alpine shell closed") uses the active distro's name.
4. Running sessions keep their rootfs; switching only affects new sessions.
   Say so in the confirmation.

**Estimate: ~1 day.**

### Phase 6: Testing

- Unit: catalog, v1/v2 records, xz extractor, package map, script generation
  for both package managers (`ProotSessionLauncherTest`).
- Device (`TerminalRuntimeDeviceTest`, `TerminalToolchainDeviceTest`,
  `TerminalCliCompatibilityDeviceTest`): parametrise over distro.
- Manual matrix on the test phone, for each distro: fresh install, Bare
  terminal, Claude Code, Codex, OpenCode, gh login + clone, remote access over
  USB, file browser, reset (rootfs only / with home).
- Upgrade: 1.0.4 with Alpine data → new build, nothing changes, sessions
  start without reinstall.
- Switch: Alpine → Debian → Alpine, harnesses work on both without
  reinstalling each time.
- Downgrade: new build on Debian → 1.0.4. Expected: 1.0.4 sees no valid
  install and offers to install Alpine; home and workspaces intact.
  Document this in the changelog.

**Estimate: ~1–1.5 days.**

## Rollout

1. Phases 1–2 can ship in a patch release alone (no visible change), which
   de-risks the record format change before Debian exists.
2. Phases 3–6 ship together with Debian marked experimental.
3. F-Droid: no new prebuilt binaries in the APK; the only new dependency is
   `org.tukaani:xz` from Maven Central. Update the store description and
   README to mention the choice.

**Total: roughly 6–7 working days**, most of it phases 3, 4 and 6.

## Open questions

- Debian release: trixie (13, current stable) is the obvious pick. Pin a
  dated debuerreotype build and bump it on a schedule like Alpine.
- Shared vs separate home: per-distro tool state with shared user config is
  the recommendation; confirm after trying the selective binds on device.
- Ubuntu: the same work covers it (apt, glibc) with one more catalog entry.
  Leave it out of the first release.
