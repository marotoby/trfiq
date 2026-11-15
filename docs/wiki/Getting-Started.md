# Getting started

Run the demo stack: an S3 server, generated demo recordings and T-RF/IQ.

## Requirements

- Docker with Compose v2 (recommended), or Podman (see the note below)
- An x86-64 machine
- A desktop browser: current Chrome, Edge or Firefox (the viewer needs WebGL2)

## Run the demo

```sh
git clone git@github.com:marotoby/trfiq.git
cd trfiq
docker compose -f deploy/compose.yml up --build
```

The first build takes a few minutes (it compiles the Rust server and the web UI).
Then open:

| URL | What |
|---|---|
| http://localhost:8080 | T-RF/IQ |
| http://localhost:9001 | The demo S3 server's console (user `trfiq`, password `trfiq-dev-secret`) |

## What the stack contains

| Service | Role |
|---|---|
| `s3` | [RustFS](https://github.com/rustfs/rustfs), a MinIO-compatible S3 server |
| `samples` | Generates the demo recordings into a volume (once; existing files are kept) |
| `seed` | Copies them into the bucket `recordings` |
| `trfiq` | The app, configured with `deploy/config.compose.yaml`: one S3 source and one local folder holding the same files |

## Demo recordings

| Recording | What to look at |
|---|---|
| `demo/ism_433_annotated` | A simulated 433 MHz band with **19 annotations**: OOK keyfob, 2-FSK sensors, LoRa, a Morse CW beacon and a sweep jammer. The best one to explore. |
| `demo/fm_band` | Broadcast FM stations |
| `demo/chirps` | Repeating linear chirps |
| `demo/bursts` | Short random bursts |
| `raw/rtl_capture.cu8` | A raw rtl_sdr capture without metadata: shows as **Needs metadata** |
| `broken/orphan` | A `.sigmf-data` without its `.sigmf-meta`: shows as **Broken** |

## A five-minute tour

1. On the **Recordings** page, type `lora` in the search box: the annotated recording matches
   by annotation label.
2. Switch to **Gallery** (top right) to see waterfall thumbnails, or stay in **Table** and rest
   the mouse on a row for a preview.
3. Open `ism_433_annotated`. Click **LoRa** in the Annotations panel: the spectrogram zooms to
   it, and the **Spectrum** and **Time** panels below show just that burst.
4. Drag a box on the spectrogram to zoom; press **Backspace** to go back and **0** to see
   everything.
5. Copy the URL and open it in another tab: you get exactly the same view.

## Using Podman

`podman-compose` can't start `trfiq` in this stack: it maps `depends_on` to Podman's
`--requires`, which needs `seed` to still be running, and `seed` exits when it's done. Either use
Docker Compose, or start `trfiq` yourself after `seed` has exited:

```sh
podman-compose -f deploy/compose.yml up -d
podman start trfiq_trfiq_1     # once `podman ps -a` shows seed as Exited (0)
```

On SELinux systems (Fedora, RHEL) bind mounts need the `:z` option; the compose file already
has it.

## Next

- Point it at your own bucket: [Configuration](Configuration.md)
- Run it for a team: [Deployment](Deployment.md)
