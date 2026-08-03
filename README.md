# Fling

A small, self-hosted file transfer app. Drag **anything** — files, folders, whole
trees — into the browser window, get a short link that is easy to read out loud,
and the recipient downloads individual files, individual folders as a zip, or the
whole thing at once.

Files are stored **encrypted at rest** on a share of your choosing, so they
survive a container restart and are unreadable without the master key.

- One container, one Node process, SQLite. Nothing external.
- Chunked uploads that **resume** — after a dropped connection, and after the
  server itself restarts mid-upload.
- **Stores your photos ~15-20% smaller, losslessly**, and proves it — see below.
- Password-protected admin page with server-side settings and a view of every
  transfer, no matter which browser sent it.

---

## Lossless shrink

A JPEG is not at the entropy floor of its pixels. It is at the floor of *its own
1992 Huffman coder*. Run `zstd -19` over a folder of photos and you will save
about **0.8%**, because a general-purpose compressor sees a finished file and has
nothing left to find.

Fling re-encodes that bitstream with a modern entropy coder instead, via
[JPEG XL](https://jpeg.org/jpegxl/)'s lossless JPEG mode. Measured on this
repository's benchmark over 20 real photos:

```
zstd -19 (general purpose)   saves  0.8%
JPEG XL lossless transcode   saves 14.7%   bit-exact 20/20
```

Same pixels. Same *file*. Byte for byte, SHA-256 identical — not "visually
lossless", not "re-encoded at high quality". The recipient downloads exactly what
the sender uploaded, and the file they get has the same checksum it had before it
was ever sent.

**How it refuses to lose your data.** Recompression only ever happens after the
round trip has been proved on the actual bytes:

1. Encode the stored file.
2. Decode it straight back.
3. Compare SHA-256 against the original.
4. Only if they match — and the result is meaningfully smaller — write the new
   blob, point the database at it, and *then* remove the first copy.

Anything unexpected at any step (encoder missing, a file that grows, a codec
quirk, a crash) leaves the file exactly as it was. A crash mid-way leaves an
unreferenced blob for the cleanup sweep to collect; it can never leave a database
row pointing at bytes that are not there. The recompressed blob is also sealed
under a **different derived key** than the original, because rewriting a blob
under the same key would reuse an AES-GCM nonce against different plaintext.

It runs in the background, one file at a time with a pause between each, because
this is a NAS sitting next to Plex. Turn it off in **Admin → Limits** and nothing
else changes.

**It is a one-way door, so know this before you enable it.** Once a file has been
shrunk, reading it back *requires* libjxl. Two consequences worth stating plainly:

- Run the image **without** `libjxl-tools` after files have been shrunk and those
  downloads fail. The bytes are still there and still encrypted with your key —
  the app just cannot decode them. It will say so explicitly rather than failing
  obscurely.
- **Downgrading to a release older than this one** leaves already-shrunk files
  undownloadable: old code has no idea what the `codec` column means and looks
  for a blob that has been superseded.

Turning the setting off stops *new* files being shrunk; it does not restore ones
already done. If you want the escape hatch, turn it off before the first upload.

**What it does not do.** Video is untouched — H.264 has no production-ready
lossless recompressor, and video is usually most of the bytes, so a video-heavy
server will see close to 0%. PNG, ZIP and Office documents are not covered yet
either; that needs [preflate](https://github.com/microsoft/preflate-rs)-style
DEFLATE reconstruction, which is a genuinely harder problem — re-deflating with
stock zlib parameters reproduced **0 of 503** real PNGs byte-exactly in testing.
The honest headline is: *photos get ~15% smaller, everything else is stored as-is.*

Recompressed files also give up O(1) range seeks, since decoding is whole-file.
That is why only files under 48 MiB are ever considered — large media stays on
the streaming path untouched.

Prior art worth naming: Dropbox shipped this idea as
[Lepton](https://github.com/dropbox/lepton) in 2016 and saved petabytes across 16
billion images. What is unusual here is not the technique, it is finding it in a
self-hosted transfer app instead of a hyperscaler's storage tier.

---

## Quick start on Unraid

Released images are published to the GitHub Container Registry, so Unraid pulls
them like anything else — nothing is built on the box:

```
ghcr.io/roandegraaf/fling:latest
```

> Setting this up from a source checkout? There has to be a published release
> before any of the below can pull anything — start at
> [Releasing → First-time setup](#first-time-setup).

### 1. Create the data directories

Do this **before** the first start. Docker would otherwise create them
root-owned, and the container — which runs as `99:100` — could not write its
master key, so the first boot would fail.

```bash
mkdir -p /mnt/cache/appdata/fling /mnt/user/fling-data
chown -R 99:100 /mnt/cache/appdata/fling /mnt/user/fling-data
```

**Put `/config` on a cache-backed path, not `/mnt/user`.** SQLite over Unraid's
fuse mount can hit file-locking problems. `/data` is plain sequential file I/O
and is perfectly happy on the array.

### 2. Install the template

Unraid reads user templates from the flash drive. Over SSH or the web terminal:

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-Fling.xml \
  https://raw.githubusercontent.com/roandegraaf/fling/main/unraid-template.xml
```

No shell? The flash drive is shared as `//<unraid-ip>/flash`, so you can drop the
file into `config/plugins/dockerMan/templates-user/` over SMB instead. Rename it
to `my-Fling.xml` either way — dockerMan expects the `my-` prefix.

### 3. Add the container

**Docker → Add Container**, then pick **Fling** from the *Template* dropdown
under **User templates**. Every field arrives filled in; check the two paths and
press **Apply**.

Then open the WebUI, go to `/admin`, and set an admin password.

Two things worth knowing about that first Apply:

- **dockerMan rewrites `my-Fling.xml`** with its own normalised copy. That is
  your check that the file parsed: re-open the template afterwards, and any
  field that came back blank was an element dockerMan did not recognise and
  dropped silently rather than reporting.
- **Later edits to the XML need the container recreated.** Editing the file
  under a running container changes nothing — re-copy it, remove the container,
  and add it again from the template.

### Updating

The Docker tab's **check for updates** works normally, since there is a real
registry behind the image. When it reports one, hit **apply update**.

To move between specific versions, edit the container and change the
`Repository` tag from `:latest` to e.g. `:v1.2.0` — every release is tagged, so
rolling back is switching the tag and pressing Apply. Your `/config` and `/data`
are untouched by any of this.

### Without the template

If you would rather fill the fields in by hand, add a container with:

| Field | Value |
| --- | --- |
| Repository | `ghcr.io/roandegraaf/fling:latest` |
| Network type | `bridge` |
| Port | `8080` → `8080` |
| Path | `/config` → `/mnt/cache/appdata/fling` |
| Path | `/data` → `/mnt/user/fling-data` |
| Extra parameters | `--user 99:100` |

The Docker UI has no "run as user" field, which is why `--user 99:100` goes in
*Extra parameters*. Without it the container runs as root and writes root-owned
files into your appdata share.

### Using docker compose instead

```bash
mkdir -p /mnt/cache/appdata/fling /mnt/user/fling-data
chown -R 99:100 /mnt/cache/appdata/fling /mnt/user/fling-data

curl -O https://raw.githubusercontent.com/roandegraaf/fling/main/docker-compose.yml
docker compose up -d
```

Note that `docker-compose.yml` sets `FLING_TRUST_PROXY=true` while the template
defaults it to `false` — see the warning under [Environment
variables](#environment-variables).

---

## Releasing

Images are built and published by GitHub Actions, not from a workstation. That
is deliberate: `better-sqlite3` compiles native code, so an image built on an ARM
Mac will not run on Unraid's x86_64, and CI's `GITHUB_TOKEN` already carries the
package-write permission a personal token would need.

```bash
scripts/release.sh patch     # 1.0.0 -> 1.0.1
scripts/release.sh minor     # 1.0.0 -> 1.1.0
scripts/release.sh 2.3.0     # explicit
scripts/release.sh patch --dry-run
```

The script refuses to run on a dirty tree, on a non-default branch, or behind
`origin`. Then it typechecks and tests, bumps the version across the workspace,
commits, tags `vX.Y.Z`, pushes, and follows the workflow to completion.

The tag is what triggers `.github/workflows/release.yml`, which runs the test
suite again on a clean checkout, builds `linux/amd64`, pushes
`ghcr.io/roandegraaf/fling:latest` and `:vX.Y.Z`, and opens a GitHub release with
generated notes.

### First-time setup

The release script assumes a repository and a remote:

```bash
git init -b main
git add . && git commit -m "initial commit"
gh repo create fling --public --source=. --push
```

**Then make the package public after the first release.** GHCR packages are
private by default and do *not* inherit the repository's visibility — Unraid
pulls anonymously, so a private package fails with a 401 that reads like the
image does not exist. Check it from any machine that is not logged in to GHCR:

```bash
docker pull ghcr.io/roandegraaf/fling:latest
```

If that fails: github.com → your profile → **Packages** → *fling* → **Package
settings** → **Change visibility** → *Public*. It is a one-time change; later
releases keep it. The release script runs this same check and tells you if it
looks wrong.

To keep the package private instead, log the Unraid box in once with a personal
access token that has `read:packages` — `docker login ghcr.io -u roandegraaf`.
That credential lands in `/root/.docker/config.json` and does not survive a
flash reinstall.

---

## Back up the master key

Every file is encrypted with a key derived from one 32-byte master key. On first
boot Fling generates one into `/config/master.key` (mode 0600).

**If you lose that file, every stored file is gone.** No recovery path exists —
that is the point of encrypting them.

Either back up `/config/master.key`, or pin the key yourself so it lives in your
own secrets store:

```bash
openssl rand -base64 32          # put the result in FLING_MASTER_KEY
```

The admin page shows which of the two is in use.

---

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `FLING_CONFIG_DIR` | `/config` | SQLite database and the master key |
| `FLING_DATA_DIR` | `/data` | Encrypted blobs |
| `FLING_PORT` | `8080` | Listen port |
| `FLING_HOST` | `0.0.0.0` | Listen address |
| `FLING_PUBLIC_URL` | *(derived)* | Base URL used in share links, e.g. `https://fling.example.com`. Leave unset to derive it from the request |
| `FLING_MASTER_KEY` | *(generated)* | 32-byte key, base64 or 64 hex chars |
| `FLING_ADMIN_PASSWORD` | *(unset)* | Sets the admin password on **every** boot while present |
| `FLING_TRUST_PROXY` | `true` | Honour `X-Forwarded-*` headers |
| `FLING_LOG_LEVEL` | `info` | Pino log level |

Everything else — max upload size, expiry limits, storage quota, cleanup
schedule — lives in the admin page, so it changes without a restart.

> **Set `FLING_TRUST_PROXY=false` if the container is reachable directly.** It
> defaults to `true` because the expected deployment has a reverse proxy in
> front. When it is on, `X-Forwarded-For` is taken at face value — and that
> header is what the rate limiter keys on, so a client that can reach the port
> without going through a proxy can rotate it and sidestep both the admin-login
> limit (10/min) and the slug-lookup limit (120/min).

### Behind a reverse proxy

Set `FLING_PUBLIC_URL` so generated links point at the public hostname, and make
sure the proxy does not cap request bodies below ~5 MB (one upload chunk is
4 MiB) or time out long downloads. For Nginx:

```nginx
client_max_body_size 16m;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

---

## How it works

### Storage format

Whole-file AES-GCM is not seekable, which would make an HTTP Range request for
byte 5 GB of a 20 GB file decrypt 5 GB of data first. So each file is stored as a
sequence of independently sealed chunks:

```
blob          = sealed(0) ‖ sealed(1) ‖ … ‖ sealed(n-1)
sealed(i)     = AES-256-GCM(plaintext chunk i) ‖ 16-byte tag
offset(i)     = i × (4 MiB + 16)
```

Because every plaintext chunk is exactly 4 MiB except the last, the offset of any
chunk is arithmetic — seeking to an arbitrary byte is O(1). Each file gets its own
key (`HKDF-SHA256(master, salt = file id)`), so the nonce can be derived from the
chunk index without ever repeating for a given key. The file id is passed as
additional authenticated data, so a blob cannot be swapped between files.

A file can hold **one of two storage variants**: the sender's bytes verbatim
(`<id>.bin`), or a losslessly recompressed encoding of them (`<id>.jxl.bin`).
`files.size` is always the original length — what a recipient is promised, and it
never changes — while `files.stored_size` is what the blob actually holds. Each
variant derives its **own** key (`HKDF-SHA256(master, salt = file id,
info = "fling-file-<variant>-v1")`) and binds the variant into the AAD. That
separation is load-bearing rather than tidy: nonces come from the chunk index
alone, so sealing two different plaintexts for one file id under a single key
would be an AES-GCM nonce reuse — the one mistake this scheme cannot survive.

### Uploads and resume

The browser splits each file into 4 MiB chunks and `PUT`s them with three
requests in flight and exponential backoff on failure. The server seals each
chunk as it arrives and writes it straight to its final offset — plaintext never
touches the disk.

Durability ordering matters: the chunk is `fdatasync`'d **before** its bit is set
in SQLite. A crash in between means the chunk is simply re-sent and overwrites
the same offset, so the operation is idempotent by construction. On reconnect the
client asks the server for its received-chunk bitmap and uploads only what is
missing.

The test suite covers this by hard-killing the server (`SIGKILL`) mid-upload,
restarting it, and asserting that exactly the interrupted chunk is reported
missing and the finished download is byte-identical.

### Downloads

Individual files stream decrypted with `Range` support. Folders and whole
transfers stream as zip archives built by `yazl`, stored rather than deflated —
the payloads are usually already-compressed media and CPU is the scarce resource
on a NAS. Storing also means the exact archive size is known up front, so the
browser shows a real progress bar instead of an unknown-length spinner.

> **Note on `zip.ts`.** yazl 3.3.1 decides the zip64 end-of-central-directory
> question in two places that disagree: the size prediction triggers at a central
> directory of `0xffff` bytes, the writer at `0xffffffff`. In between — roughly
> 800 files and up — it predicts 76 bytes more than it writes, so a
> `Content-Length` built from it leaves the client waiting for bytes that never
> arrive and the download dies near the end. `zip64Plan()` decides the flag
> explicitly so both paths agree. `zip.test.ts` straddles that boundary; if it
> ever starts failing after a yazl upgrade, that is why.

### What the download limit actually counts

One "download" is **one person actually taking the files** — not one file, and
not merely looking at the page. Concretely:

- **Opening the transfer is free.** A recipient can see what is there, close the
  tab, and come back later without spending anything.
- **The first file, folder zip or download-all charges one** — and everything
  else that visitor grabs is included. A limit of 1 still lets them take all
  5000 files, individually or as one archive.
- **Re-clicking the link is free.** Closing the tab loses the token, so the
  server also recognises a returning visitor for 6 hours and reuses their
  session rather than charging again.
- **A different person costs another download**, and once the allowance is gone
  they get a page explaining why rather than a broken link.

The limit is enforced at the moment files are fetched, not when a page is
opened — so opening ten tabs first does not get you ten downloads.

Returning visitors are recognised by an HMAC of their address keyed with the
master key, not the address itself, so the database never accumulates recipients'
IPs. Those rows are swept after a day.

An unlimited link with no password is never refused, so those URLs can be
forwarded around freely; downloads are still counted so the sender's history
stays meaningful.

Because downloads are plain links, a refusal lands in the address bar rather than
in `fetch()`. Those responses content-negotiate: a browser navigation gets a
styled page explaining what happened, while the app's own requests still get JSON.

### Links

Slugs look like `8xk2-vq7m`: two groups of four from a 31-character alphabet with
no `0/O` and no `1/l/I`, so they survive being read out over the phone. Slug
lookups are rate limited.

---

## Development

```bash
npm install
npm run dev          # Vite on :5173 proxying /api to the server on :8080
npm test             # unit + end-to-end (spawns a real server)
npm run typecheck
npm run build && npm start
```

In development the data directories default to `./.data/config` and
`./.data/files` rather than `/config` and `/data`.

### Layout

```
server/src
  crypto.ts     chunk sealing, key derivation, passwords, signed grants
  storage.ts    blob layout, chunk writes, seekable decrypting streams
  db.ts         SQLite schema, migrations, chunk bitmaps
  zip.ts        streaming zip64 over encrypted sources
  tree.ts       flat file rows → folder tree
  cleanup.ts    expiry, abandoned uploads, orphaned blobs
  routes/       upload, download, admin
web/src
  lib/uploader.ts   chunked upload with retry, resume, progress
  lib/picker.ts     drag-and-drop folder tree walking
  pages/            send, download, history, admin
```

---

## License

MIT — see [LICENSE](LICENSE).

The webfonts in `web/public/fonts` (Be Vietnam Pro and Outfit) are redistributed
under the SIL Open Font License 1.1; see `web/public/fonts/OFL.txt`.
