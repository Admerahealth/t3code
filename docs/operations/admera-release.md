# Admera fork releases

Run **Actions > Fork release** on `main` with the next unused plain version, such as `0.0.46`.
The workflow tests Hermes and the Admera status line, typechecks the shipped apps, and builds
Windows and Linux x64 desktop installers and CLI archives using GitHub-hosted runners.
Windows includes the matching Linux archive for WSL.

The workflow creates a draft release with checksums and updater metadata. Verify the downloads
and publish the draft from GitHub Releases, or run:

```bash
gh release edit v0.0.46 --repo Admerahealth/t3code --draft=false --latest
```

Fork desktop builds check this repository for updates. Install a fork build once to follow that
feed. Hermes remains part of subsequent builds from this fork.

The build uses the public T3 Connect configuration in `.env.example`. It needs no upstream
deployment credentials and publishes only to this repository. Installers are unsigned.
