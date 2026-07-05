# Linux App

Linux users receive a single `.run` file:

```text
app/LittleAlphaxiv-<version>-x86_64.run
```

Run it directly:

```bash
chmod +x app/LittleAlphaxiv-<version>-x86_64.run
./app/LittleAlphaxiv-<version>-x86_64.run
```

The app opens Little Alphaxiv in the browser and stores user data under
`$XDG_DATA_HOME/little-alphaxiv` or `~/.local/share/little-alphaxiv`.
