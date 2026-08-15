# v0.2.0 — wave `infra` report

Scope: audit ranks **7, 12, 17, 18, 19**.
Files owned and touched: `Dockerfile`, `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, plus `README.md` (rank-12 documentation only).
`.dockerignore` was owned but needed no change — see "Not changed" below.

## Commits

| sha | subject |
| --- | --- |
| `4b92b5f` | fix: build the image from a fixed base, without dependency install scripts |
| `c340c54` | docs: tell a self-hoster to configure the health probe the platform actually runs |
| `69d682a` | fix: pin every action to a commit, not to a tag someone else can move |
| `e6f8d42` | fix: boot the image before pushing it to the tag production pulls |

Final state: `npm test` 235 passing / 0 failing, `npm run lint`
(`eslint . && tsc --noEmit`) clean, `docker build` clean, smoke test green
against the image built from the committed tree.

---

## Rank 7 — the released image is now executed before it is pushed

**What shipped.** Both workflows gained a `Smoke-test the image` step. In
`release.yml` it sits between a new `linux/amd64` `load: true, push: false`
build and the push, and — deliberately — **before** the Docker Hub login: a
build that cannot boot never gets as far as authenticating to the registry.
`ci.yml`'s docker job gained `load: true` (it previously built an image nobody
could run) and the identical step, so a PR catches this rather than the tag.

The step asserts three things:

1. `GET /` answers within 30s with the identity JSON (`"status":"ok"`,
   `"server":"confetti-mcp"`). The poll loop checks `docker inspect
   .State.Running` each round, so a container that exits fails in ~1s with its
   logs dumped rather than idling for the full 30s.
2. the version in that JSON equals `jq -r .version package.json` — an image
   built from stale source is caught here, not in production.
3. `POST /mcp` with **no** API key returns **401**.

On any failure it prints `docker logs … | tail -50`, which is the diagnosis the
old pipeline never produced, then removes the container.

**How it was tested (RED first).** The step body was developed as a standalone
script and run against three deliberately broken images before it was ever run
against a good one. Fixtures live in the scratchpad
(`…/scratchpad/smoke/`), not in the repo.

| fixture | expected to catch | actual RED output |
| --- | --- | --- |
| repo Dockerfile with `COPY --from=build /app/dist ./dist` deleted (the "file missing from the COPY list" case rank 7 names) | container never serves | `smoke: FAIL: the container exited before it answered GET /` + dumped log `Error: Cannot find module '/app/dist/main.js' … MODULE_NOT_FOUND`, exit 1 |
| a server that returns a correct-looking identity JSON on `/` but serves `/mcp` unauthenticated | the 401 assertion has teeth | `smoke: GET / -> {"status":"ok",…}` then `smoke: FAIL: POST /mcp with no API key returned 200, expected 401`, exit 1 |
| same server reporting `version: 0.0.0-stale` | stale-source image | `smoke: FAIL: the image reports a version other than 0.1.0 — it was built from stale source`, exit 1 |

GREEN, against the real image built from the committed `Dockerfile`:

```
smoke: GET / -> {"status":"ok","server":"confetti-mcp","version":"0.1.0","usage":"POST /mcp with an \"Authorization: Bearer <confetti-api-key>\" header.","filtering":"All 63 tools are exposed by default. …"}
smoke: POST /mcp with no key -> 401
smoke: PASS
```

**Verification that the YAML carries the script that was actually tested.** A
checker parses both workflows with PyYAML, extracts the `Smoke-test the image`
`run:` body, normalises only the image tag, and diffs it against the script the
RED/GREEN runs used. Both report *identical*. The same checker asserts every
`uses:` in both files is a 40-character SHA. Re-run it if you edit either step —
the two copies are hand-synced (see "Follow-ups").

**Residual gap (intentional, documented in the commit).** The `arm64` variant
is still built under QEMU and executed by nobody. Azure runs amd64, and running
an emulated arm64 container in CI costs minutes for a platform nothing deploys.
The push build reuses the same context, Dockerfile and buildx gha cache as the
smoke build, so the amd64 layers published are the ones that just booted.

## Rank 12 — Azure health check documented

`HEALTHCHECK` is kept (it is the mechanism under plain Docker and compose) and
now carries a comment saying managed platforms ignore it. The README's
self-hosting section replaces the misleading single line "The image's own
`HEALTHCHECK` uses this endpoint." with an explicit instruction to configure the
platform's own probe at `/`, plus a table: Azure App Service (Settings → Health
check → path `/`, **off by default**), ECS/ALB target group, Kubernetes
`livenessProbe.httpGet.path`, and Docker/compose (nothing to configure).

Not done, because it is not a repo change: actually enabling Health check on the
App Service. The audit's fix (`healthCheckPath: "/"`) has to be applied in Azure.

## Rank 17 — `--ignore-scripts`

Added to all four `npm ci` invocations: both Dockerfile stages, `ci.yml`,
`release.yml`.

I verified the lockfile claim myself rather than taking it from the audit: the
only packages with `hasInstallScript` are `node_modules/esbuild` and
`node_modules/fsevents`, and both are `dev: true`. So production installs lose
nothing.

**This one had a real risk the audit did not call out**: `tsx` — which runs the
entire test suite — depends on `esbuild`, and esbuild's platform binary is
wired up by exactly the install script being disabled. "Zero *production*
packages have install scripts" does not answer whether `npm test` still works.
So it was verified end to end in a clean container, on both architectures:

```
docker run --rm -v <clean git-archive of HEAD>:/w -w /w node:22 \
  sh -c 'npm ci --ignore-scripts && npm run lint && npm test'
```

- arm64: install ok, lint clean, `# pass 235 / # fail 0`
- `--platform linux/amd64` (what the runner is): `amd64 install ok`, lint clean,
  `# pass 235 / # fail 0`

esbuild resolves through its optional platform dependency without the hook. The
Docker path is separately proven by a `--no-cache` build of the full image
followed by the smoke test.

## Rank 18 — base image pinned by digest

Both `FROM` lines are `node:22-alpine@sha256:c610fcdf…aa32`, the multi-arch
index digest resolved with `docker buildx imagetools inspect node:22-alpine` on
2026-08-15. The header comment names the tag, the concrete contents (node
v22.23.2, Alpine 3.24.1 — read out of the pinned image itself), and the exact
command that produces a replacement digest, so the pin can be moved by a human
who has never seen this file.

The audit notes a digest pin is "only worth doing alongside an update bot".
`.github/dependabot.yml` is **not** in this wave's file list, so I did not
create it — see "Follow-ups". Until it exists, moving the digest is a manual
chore, and a frozen digest trades patch regressions for staleness.

## Rank 19 — actions pinned to commit SHAs

Every `uses:` in both workflows now names a full 40-character commit with the
version in a trailing comment. **Every SHA was resolved with `gh api` and then
verified a second time back against its release tag** (`repos/<repo>/tags` →
`.commit.sha` for the named version); none was written from memory.

| action | SHA | is |
| --- | --- | --- |
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| `docker/setup-buildx-action` | `8d2750c68a42422c14e847fe6c8ac0403b4cbd6f` | v3.12.0 |
| `docker/build-push-action` | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` | v6.19.2 |
| `docker/setup-qemu-action` | `c7c53464625b32c7a7e944ae62b3e17d2b600130` | v3.7.0 |
| `docker/login-action` | `c94ce9fb468520275223c153574b00df6fe4bcc9` | v3.7.0 |
| `docker/metadata-action` | `c299e40c65443455700f0fdfc63efafe5b349051` | v5.10.0 |

**Deliberate choice:** each SHA is the commit the *currently used major tag*
points at, so this commit changes zero behaviour. Newer majors exist
(`actions/checkout` v7.0.1, `setup-node` v7.0.0, `build-push-action` v7.3.0,
`setup-buildx`/`setup-qemu` v4.2.0, `login-action` v4.6.0, `metadata-action`
v6.2.0). Pinning and upgrading in one commit would have meant an untestable
change; upgrading majors is a separate decision and is listed below.

`release.yml` carries the header explaining *why* this file in particular is
pinned (it holds `DOCKERHUB_TOKEN` and the webhook auto-deploys what it pushes)
and the `gh api` recipe for moving a pin; `ci.yml` points at it.

## Not changed

- **`.dockerignore`** — owned by this wave, reviewed, no change needed. It
  already excludes `node_modules`, `dist`, `.git`, `test`, `docs`, `.env` and
  `*.log`; the Dockerfile only `COPY`s named paths, so the context is not a
  correctness or leak risk. Editing it for its own sake would have invalidated
  build caches for nothing.

## Follow-ups this wave could not take

1. **`.github/dependabot.yml` (github-actions + docker ecosystems)** — not in my
   file list, so not created. Both rank 18 and rank 19 explicitly want it: the
   base-image digest and the seven action SHAs are now deliberately frozen and
   need a bot to propose bumps. Whoever owns repo-config files should add it.
2. **`scripts/smoke.sh`** — the smoke body is duplicated verbatim in two
   workflows because a shared script file is outside this wave's ownership. The
   PyYAML checker above catches drift, but the right end state is one script
   both workflows call. The tested copy is at
   `…/scratchpad/smoke/smoke.sh`.
3. **Azure App Service "Health check" must actually be switched on** (path `/`).
   Rank 12 is only half fixed by documentation.
4. **Rank 8 is untouched** and is the strictly larger remaining risk: the
   webhook still makes a mutable Docker Hub tag the production trust root. The
   smoke test guarantees *we* never push a broken image; it guarantees nothing
   about what else can be pushed to that tag. Scoping `DOCKERHUB_TOKEN` to a
   push-only single-repo token is the cheap half.
5. **Action major upgrades** (list under rank 19) — worth a deliberate pass now
   that the smoke test would catch a breakage in the docker steps.
6. **`package.json` version is still `0.1.0`.** The release job's tag-vs-version
   check and the smoke test's version assertion both compare against it, so
   whoever bumps to `0.2.0` needs no infra change — but a `v0.2.0` tag pushed
   before that bump will fail the release job at the first step, by design.
