# Linux Release Packaging

This folder is for maintainers building the Linux `.run` release artifact.

Run from the repository root:

```bash
packaging/linux/build-linux-run.sh
```

The script creates `app/` at the repository root. That directory is ignored by
Git and contains:

- `LittleAlphaxiv-<version>-<arch>.run` — the single executable file to upload
  to GitHub Releases. `<arch>` is the build host's `uname -m` (e.g. `x86_64`,
  `aarch64`); build on the target architecture.
- `.build/` — temporary packaging files, including the assembled app payload.

To set an explicit release version:

```bash
LAX_APP_VERSION=v0.1.0 packaging/linux/build-linux-run.sh
```

After the build, publish only:

```text
app/LittleAlphaxiv-<version>-<arch>.run
```

Users download that `.run` file from the release page, grant execute permission,
and run it directly.

## Portability caveats

- **libpython is bundled.** Distro pythons (apt/dnf-installed) dynamically link
  `libpython3.x.so.1.0`; the script detects it via `ldd` and ships it next to
  the interpreter, setting `LD_LIBRARY_PATH` at runtime. Statically-linked
  pythons skip this step.
- **C extensions are bound to the build host's glibc.** `bcrypt`,
  `cryptography`, and `pydantic-core` ship as pre-built wheels whose `.so`
  files depend on the build host's glibc version. For the widest reach, build
  on an older glibc base (e.g. a `manylinux2014` container) — a build from a
  newer distro will fail to load these `.so` files on older ones.
- **Linux only.** Windows / macOS packaging is not in scope.
- **Requires `npm`, `tar`, `sha256sum`, and Python 3.10+** on the build host.
