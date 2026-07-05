# Linux Release Packaging

This folder is for maintainers building the Linux `.run` release artifact.

Run from the repository root:

```bash
packaging/linux/build-linux-run.sh
```

The script creates `app/` at the repository root. That directory is ignored by
Git and contains:

- `LittleAlphaxiv-<version>-x86_64.run` — the single executable file to upload
  to GitHub Releases.
- `.build/` — temporary packaging files, including the assembled app payload.

To set an explicit release version:

```bash
LAX_APP_VERSION=v0.1.0 packaging/linux/build-linux-run.sh
```

After the build, publish only:

```text
app/LittleAlphaxiv-<version>-x86_64.run
```

Users download that `.run` file from the release page, grant execute permission,
and run it directly.
