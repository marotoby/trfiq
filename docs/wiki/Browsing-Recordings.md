# Browsing recordings

The **Recordings** page lists everything in the index.

## Sources

One card per configured source shows its recording count, how many need metadata or are
broken, and when it was last scanned (with how long the scan took). The ↻ button rescans that
source now. While a scan runs the card shows *Scanning…*, and the list refreshes when it
finishes. If a scan fails, the card says so; hover it for the error.

## Search and filter

- **Search** matches words, and word prefixes, in paths, names, descriptions, author,
  hardware and annotation labels. `lora` finds every recording with a LoRa annotation.
- **All / Ready / Needs metadata / Broken** filters by [status](Recordings-and-Formats.md#status).

The API also filters by datatype, frequency band and capture date (see [HTTP API](HTTP-API.md));
those filters aren't in the UI yet.

Search text, filters and view mode are kept in the URL, so you can bookmark or share them.

## Table view

<img src="../images/screenshot-recordings.jpg" alt="Table view with hover preview" width="720">

- Click a column header to sort; click again to reverse.
- **Rest the mouse on a row** for a moment to see a waterfall preview of the whole recording,
  with its duration and frequency span. Broken recordings have no preview.
- Click a row to open it in the [viewer](Using-the-Viewer.md).

The table only renders the rows on screen, so it stays smooth with tens of thousands of rows.

## Gallery view

<img src="../images/screenshot-gallery.jpg" alt="Gallery view" width="720">

A card per recording with a waterfall thumbnail, its source, annotation count, centre
frequency, sample rate, duration, size and labels. Broken recordings show why instead of a
picture. Click a card to open it.

Thumbnails load only when they scroll into view and are cached for the session. They are
coloured from the noise floor up so signals stand out.

> Thumbnails, like the viewer's first view, are built from evenly spaced slices of the file.
> Very short, sparse bursts can fall between slices and not show up. The max-hold pyramid on
> the roadmap fixes this.

## Remembered choices

Your last table/gallery choice is remembered in the browser. A `?view=table` or
`?view=gallery` in the URL takes precedence.
