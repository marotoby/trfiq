# Releasing

Versions follow [SemVer](https://semver.org). Until 1.0, breaking changes bump the minor
version (commitizen `major_version_zero`). Prereleases look like `0.2.0-beta.0`. Tags are
`v<version>`.

[Commitizen](https://commitizen-tools.github.io/commitizen/) (config in `.cz.toml`) works out
the next version from the commits since the last tag, updates `Cargo.toml`, `web/package.json`
and `CHANGELOG.md`, and tags.

## Steps

1. Start from an up-to-date, clean `main` with CI green.
2. Bump only the files, so `Cargo.lock` can be synced before committing:

   ```sh
   uvx --from commitizen cz bump --yes --files-only                      # stable
   uvx --from commitizen cz bump --yes --files-only --prerelease beta    # next beta
   ```

3. Sync the lockfile (commitizen doesn't know about it, and CI builds with `--locked`):

   ```sh
   scripts/cargo.sh update --workspace
   ```

4. Commit and tag (`X` is the new version, as printed in step 2):

   ```sh
   git add .cz.toml CHANGELOG.md Cargo.toml Cargo.lock web/package.json
   git commit -m "bump: version <old> → X"
   git tag -a vX -m "T-RF/IQ vX"
   git push origin main --follow-tags
   ```

5. Build and tag the image:

   ```sh
   docker build -f deploy/Dockerfile -t trfiq:X .
   ```

6. On GitHub, create a Release from the tag and paste that version's `CHANGELOG.md` section.
   Mark betas as pre-releases.

Run `cz bump --dry-run` (with the same flags) first to preview the version and changelog.

## History

| Version | Date | |
|---|---|---|
| `0.2.0-beta.0` | 2026-11-15 | First beta: indexing, viewer, annotations, spectrum and time plots, table and gallery views |
