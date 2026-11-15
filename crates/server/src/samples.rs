//! Sample-window reader: everything between "these samples of this recording" and "here is the
//! result, computed on them". Window validation, read planning under the detail cap, fetching
//! byte ranges, cancellable compute on the rayon pool, and timing all live here, so the HTTP
//! handlers only parse parameters and encode responses.

use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{Result, anyhow};
use bytes::Bytes;
use trfiq_dsp::{Datatype, DspError};
use trfiq_storage::Source;

/// Most samples one detail request (PSD, time) reads. Larger windows are sampled evenly.
pub const DETAIL_CAP: u64 = 2 << 20;

/// A `[start, start + count)` range of samples within a recording. Never empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleWindow {
    pub start: u64,
    pub count: u64,
}

impl SampleWindow {
    /// The whole recording.
    pub fn whole(num_samples: u64) -> Self {
        Self {
            start: 0,
            count: num_samples.max(1),
        }
    }

    /// `start` defaults to 0 and `count` to the rest of the recording. A window that starts at
    /// or past the end, or is empty, is an error; one that runs past the end is trimmed.
    pub fn new(start: Option<u64>, count: Option<u64>, num_samples: u64) -> Result<Self, String> {
        let start = start.unwrap_or(0);
        if start >= num_samples {
            return Err(format!(
                "start {start} is past the end of the recording ({num_samples} samples)"
            ));
        }
        let count = count.unwrap_or(u64::MAX);
        if count == 0 {
            return Err("count must be at least 1".into());
        }
        Ok(Self {
            start,
            count: count.min(num_samples - start),
        })
    }

    pub fn end(&self) -> u64 {
        self.start + self.count
    }

    pub fn range(&self) -> Range<u64> {
        self.start..self.end()
    }
}

/// What a detail request needs from its window; [`ReadPlan::detail`] applies the cap to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coverage {
    /// `k` equal buckets spanning the window (the time envelope).
    Buckets(u64),
    /// Back-to-back segments of this many samples (the PSD's FFT segments).
    Segments(u64),
}

/// The sample ranges to read, in order; each becomes one chunk handed to the compute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadPlan {
    slots: Vec<Range<u64>>,
    /// The slots tile one range: fetch it once and split, instead of one read per slot.
    contiguous: bool,
}

impl ReadPlan {
    /// Back-to-back slots of `len` samples from the window's start. The last may be shorter;
    /// a window shorter than `len` gives one short slot. Covers `⌊count/len⌋` slots (at least
    /// one), so a partial tail after whole slots is not read.
    pub fn segments(window: SampleWindow, len: u64) -> Self {
        let len = len.max(1);
        let k = (window.count / len).max(1);
        let slots = (0..k)
            .map(|i| {
                let a = window.start + i * len;
                a..(a + len).min(window.end())
            })
            .collect();
        Self {
            slots,
            contiguous: true,
        }
    }

    /// `k` reads of `len` samples spread evenly from the window's start to its end.
    pub fn spread(window: SampleWindow, k: u64, len: u64) -> Self {
        let k = k.max(1);
        let span = window.count.saturating_sub(len);
        let slots = (0..k)
            .map(|i| {
                let a = window.start + if k == 1 { 0 } else { i * span / (k - 1) };
                a..(a + len).min(window.end())
            })
            .collect();
        Self {
            slots,
            contiguous: false,
        }
    }

    /// One FFT-sized read per spectrogram row (ADR 0006). The window is split into `rows`
    /// equal time slots and each read is centred in its slot, so row `i` stands for the
    /// samples the viewer draws it over. Never more rows than whole FFTs in the window (at
    /// least one); reads near its edges are shifted inwards to stay inside it. When the slots
    /// are exactly one FFT long, the reads tile the window and every sample is used.
    pub fn rows(window: SampleWindow, rows: u64, fft: u64) -> Self {
        let n = window.count;
        let fft = fft.max(1);
        let rows = rows.min(n / fft).max(1);
        let last = window.end().saturating_sub(fft).max(window.start);
        let slots: Vec<Range<u64>> = (0..rows)
            .map(|i| {
                // Centre of slot i is start + (i + ½)·n/rows.
                let centre =
                    window.start + ((2 * i + 1) as u128 * n as u128 / (2 * rows) as u128) as u64;
                let a = centre.saturating_sub(fft / 2).clamp(window.start, last);
                a..(a + fft).min(window.end())
            })
            .collect();
        let contiguous = slots.windows(2).all(|p| p[0].end == p[1].start);
        Self { slots, contiguous }
    }

    /// [`ReadPlan::rows`] over the whole recording: the overview.
    pub fn overview(num_samples: u64, rows: u64, fft: u64) -> Self {
        Self::rows(SampleWindow::whole(num_samples), rows, fft)
    }

    /// The plan for a detail request. Up to [`DETAIL_CAP`] samples, every sample is read in one
    /// range; beyond it, the reads are spread evenly and total about `DETAIL_CAP` samples.
    pub fn detail(window: SampleWindow, coverage: Coverage) -> Self {
        let within_cap = window.count <= DETAIL_CAP;
        match coverage {
            Coverage::Segments(len) if within_cap => Self::segments(window, len),
            Coverage::Segments(len) => Self::spread(window, (DETAIL_CAP / len.max(1)).max(1), len),
            Coverage::Buckets(k) => {
                let k = k.clamp(1, window.count);
                let edge = |b: u64| window.start + b * window.count / k;
                if within_cap {
                    let slots = (0..k).map(|b| edge(b)..edge(b + 1)).collect();
                    Self {
                        slots,
                        contiguous: true,
                    }
                } else {
                    let len = (DETAIL_CAP / k).max(1);
                    let slots = (0..k).map(|b| edge(b)..edge(b) + len).collect();
                    Self {
                        slots,
                        contiguous: false,
                    }
                }
            }
        }
    }

    pub fn slots(&self) -> &[Range<u64>] {
        &self.slots
    }

    /// True when the plan reads evenly spaced parts of the window rather than all of it.
    pub fn is_sampled(&self) -> bool {
        !self.contiguous
    }
}

/// A computed value with how long reading and computing took.
#[derive(Debug)]
pub struct Timed<T> {
    pub value: T,
    pub read_ms: f64,
    pub compute_ms: f64,
}

impl<T> Timed<T> {
    /// A `Server-Timing` header value.
    pub fn server_timing(&self) -> String {
        format!(
            "read;dur={:.1}, compute;dur={:.1}",
            self.read_ms, self.compute_ms
        )
    }
}

/// Reads planned sample ranges of one recording's data object and computes on them.
pub struct SampleReader {
    src: Arc<Source>,
    key: String,
    dt: Datatype,
    num_samples: u64,
}

/// Sets the cancel flag when dropped: the request future was dropped (client went away).
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl SampleReader {
    pub fn new(src: Arc<Source>, key: String, dt: Datatype, num_samples: u64) -> Self {
        Self {
            src,
            key,
            dt,
            num_samples,
        }
    }

    pub fn num_samples(&self) -> u64 {
        self.num_samples
    }

    pub fn datatype(&self) -> Datatype {
        self.dt
    }

    /// Read the plan's slots (one chunk each, in order, trimmed at the end of the data) and run
    /// `compute` on them on the rayon pool. If the returned future is dropped, reading stops
    /// and `compute` sees its cancel flag set.
    pub async fn run<T, F>(&self, plan: &ReadPlan, compute: F) -> Result<Timed<T>>
    where
        T: Send + 'static,
        F: FnOnce(&[Bytes], &AtomicBool) -> Result<T, DspError> + Send + 'static,
    {
        let cancel = Arc::new(AtomicBool::new(false));
        let _guard = CancelOnDrop(cancel.clone());

        let t_read = Instant::now();
        let chunks = self.fetch(plan).await?;
        let read_ms = t_read.elapsed().as_secs_f64() * 1e3;

        let t_compute = Instant::now();
        let (tx, rx) = tokio::sync::oneshot::channel();
        rayon::spawn(move || {
            let _ = tx.send(compute(&chunks, &cancel));
        });
        let value = rx
            .await
            .map_err(|_| anyhow!("compute task ended without a result"))?
            .map_err(|e| anyhow!(e))?;
        Ok(Timed {
            value,
            read_ms,
            compute_ms: t_compute.elapsed().as_secs_f64() * 1e3,
        })
    }

    async fn fetch(&self, plan: &ReadPlan) -> Result<Vec<Bytes>> {
        let ss = self.dt.sample_size() as u64;
        let end = self.num_samples * ss;
        let bytes = |r: &Range<u64>| (r.start * ss).min(end)..(r.end * ss).min(end);
        if !plan.contiguous {
            let ranges: Vec<_> = plan.slots.iter().map(bytes).collect();
            return self.src.get_ranges(&self.key, &ranges).await;
        }
        let (Some(first), Some(last)) = (plan.slots.first(), plan.slots.last()) else {
            return Ok(Vec::new());
        };
        let whole = bytes(&(first.start..last.end));
        let buf = self
            .src
            .get_ranges(&self.key, std::slice::from_ref(&whole))
            .await?
            .remove(0);
        let len = buf.len() as u64;
        Ok(plan
            .slots
            .iter()
            .map(|r| {
                let r = bytes(r);
                let a = (r.start - whole.start).min(len) as usize;
                let b = (r.end - whole.start).min(len) as usize;
                buf.slice(a..b)
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(start: u64, count: u64) -> SampleWindow {
        SampleWindow { start, count }
    }

    #[test]
    fn windows_are_validated_and_trimmed() {
        assert_eq!(SampleWindow::new(None, None, 100), Ok(w(0, 100)));
        assert_eq!(SampleWindow::new(Some(90), Some(50), 100), Ok(w(90, 10)));
        assert!(SampleWindow::new(Some(100), None, 100).is_err());
        assert!(SampleWindow::new(Some(5), Some(0), 100).is_err());
    }

    #[test]
    fn segments_tile_the_window() {
        let p = ReadPlan::segments(w(10, 100), 32);
        assert_eq!(p.slots(), &[10..42, 42..74, 74..106]);
        assert!(!p.is_sampled());
        // Shorter than one segment: one short slot.
        assert_eq!(ReadPlan::segments(w(0, 5), 32).slots(), [w(0, 5).range()]);
    }

    #[test]
    fn detail_reads_everything_up_to_the_cap() {
        let at_cap = ReadPlan::detail(w(0, DETAIL_CAP), Coverage::Buckets(4));
        assert!(!at_cap.is_sampled());
        let q = DETAIL_CAP / 4;
        assert_eq!(
            at_cap.slots(),
            &[0..q, q..2 * q, 2 * q..3 * q, 3 * q..4 * q]
        );

        let over = ReadPlan::detail(w(0, DETAIL_CAP + 1), Coverage::Buckets(4));
        assert!(over.is_sampled());
        assert_eq!(over.slots().len(), 4);
        let total: u64 = over.slots().iter().map(|r| r.end - r.start).sum();
        assert!(total <= DETAIL_CAP);

        let psd = ReadPlan::detail(w(0, 10 * DETAIL_CAP), Coverage::Segments(1024));
        assert!(psd.is_sampled());
        assert_eq!(psd.slots().len() as u64, DETAIL_CAP / 1024);
        assert!(psd.slots().iter().all(|r| r.end - r.start == 1024));
        assert!(psd.slots().last().unwrap().end <= 10 * DETAIL_CAP);
    }

    #[test]
    fn overview_rows_are_centred_in_equal_slots() {
        // 4 slots of 1000 samples; reads of 100 centred at 500, 1500, 2500, 3500.
        let p = ReadPlan::overview(4000, 4, 100);
        assert_eq!(p.slots(), &[450..550, 1450..1550, 2450..2550, 3450..3550]);
        // An exact fit tiles the file.
        assert_eq!(
            ReadPlan::overview(400, 4, 100).slots(),
            &[0..100, 100..200, 200..300, 300..400]
        );
        // Never more rows than whole FFTs; edge reads are clamped inside the file.
        let p = ReadPlan::overview(450, 100, 100);
        assert_eq!(p.slots().len(), 4);
        assert!(
            p.slots()
                .iter()
                .all(|r| r.end <= 450 && r.end - r.start == 100)
        );
        // A file shorter than one FFT: one short row.
        assert_eq!(ReadPlan::overview(10, 8, 100).slots(), [w(0, 10).range()]);
    }

    #[test]
    fn rows_of_a_window_stay_inside_it() {
        // Window 1000..5000 in 4 slots of 1000; reads of 100 centred at 1500, 2500, ….
        let p = ReadPlan::rows(w(1000, 4000), 4, 100);
        assert_eq!(p.slots(), &[1450..1550, 2450..2550, 3450..3550, 4450..4550]);
        assert!(p.is_sampled());
        // As many rows as FFTs: back to back, every sample used, read in one range.
        let p = ReadPlan::rows(w(1000, 400), 1024, 100);
        assert_eq!(p.slots(), &[1000..1100, 1100..1200, 1200..1300, 1300..1400]);
        assert!(!p.is_sampled());
        // Edge reads are shifted inwards, never outside the window.
        let p = ReadPlan::rows(w(500, 250), 2, 100);
        assert!(
            p.slots()
                .iter()
                .all(|r| r.start >= 500 && r.end <= 750 && r.end - r.start == 100)
        );
    }

    #[test]
    fn buckets_never_outnumber_samples() {
        let p = ReadPlan::detail(w(7, 3), Coverage::Buckets(100));
        assert_eq!(p.slots(), &[7..8, 8..9, 9..10]);
    }

    // ---- reading, through a local-folder source ----

    use std::time::Duration;
    use trfiq_storage::{SourceConfig, SourceKind};

    /// A `ci16` file whose samples encode their own index (I = low 15 bits, Q = the rest).
    fn indexed_recording(n: u64) -> (tempfile::TempDir, SampleReader) {
        let dir = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..n)
            .flat_map(|i| [(i & 0x7fff) as i16, (i >> 15) as i16])
            .flat_map(i16::to_le_bytes)
            .collect();
        std::fs::write(dir.path().join("x.sigmf-data"), data).unwrap();
        let src = Source::new(&SourceConfig {
            id: "t".into(),
            name: None,
            prefix: String::new(),
            max_concurrency: 4,
            kind: SourceKind::Local {
                path: dir.path().into(),
            },
        })
        .unwrap();
        let dt = Datatype::parse("ci16_le").unwrap();
        (
            dir,
            SampleReader::new(Arc::new(src), "x.sigmf-data".into(), dt, n),
        )
    }

    /// Each chunk as the sample range it holds.
    fn ranges_read(chunks: &[Bytes]) -> Vec<Range<u64>> {
        let index = |b: &[u8]| {
            u64::from(u16::from_le_bytes([b[0], b[1]]))
                | u64::from(u16::from_le_bytes([b[2], b[3]])) << 15
        };
        chunks
            .iter()
            .map(|c| match c.len() {
                0 => 0..0,
                len => index(c)..index(&c[len - 4..]) + 1,
            })
            .collect()
    }

    async fn read(reader: &SampleReader, plan: &ReadPlan) -> Vec<Range<u64>> {
        let t = reader
            .run(plan, |chunks, _| Ok(ranges_read(chunks)))
            .await
            .unwrap();
        assert!(t.read_ms >= 0.0 && t.compute_ms >= 0.0);
        assert!(t.server_timing().starts_with("read;dur="));
        t.value
    }

    #[tokio::test]
    async fn contiguous_plans_read_exactly_their_slots() {
        let (_dir, r) = indexed_recording(10_000);
        let plan = ReadPlan::detail(w(1000, 4000), Coverage::Buckets(3));
        assert_eq!(read(&r, &plan).await, plan.slots());
        let plan = ReadPlan::segments(w(9000, 1000), 256);
        assert_eq!(read(&r, &plan).await, plan.slots());
    }

    #[tokio::test]
    async fn sampled_plans_read_spread_slices() {
        let n = DETAIL_CAP + DETAIL_CAP / 2;
        let (_dir, r) = indexed_recording(n);
        let plan = ReadPlan::detail(SampleWindow::whole(n), Coverage::Segments(4096));
        assert!(plan.is_sampled());
        let got = read(&r, &plan).await;
        assert_eq!(got, plan.slots());
        assert_eq!(got.first().unwrap().start, 0);
        assert_eq!(got.last().unwrap().end, n);
    }

    #[tokio::test]
    async fn reads_stop_at_the_end_of_the_data() {
        // A short file: the index says 100 samples, a slot asks for 64 from sample 80.
        let (_dir, r) = indexed_recording(100);
        let plan = ReadPlan::segments(w(80, 64), 64);
        assert_eq!(read(&r, &plan).await, [w(80, 20).range()]);
        let plan = ReadPlan::spread(w(0, 100), 2, 64);
        assert_eq!(read(&r, &plan).await, vec![0..64, 36..100]);
    }

    #[tokio::test]
    async fn dropping_the_request_cancels_the_compute() {
        let (_dir, r) = indexed_recording(1000);
        let (tx, rx) = std::sync::mpsc::channel();
        let plan = ReadPlan::segments(w(0, 1000), 100);
        let run = r.run(&plan, move |_, cancel| {
            let t0 = Instant::now();
            while !cancel.load(Ordering::Relaxed) && t0.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(1));
            }
            tx.send(cancel.load(Ordering::Relaxed)).unwrap();
            Err::<(), _>(DspError::Cancelled)
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(50), run)
                .await
                .is_err()
        );
        let saw_cancel = tokio::task::spawn_blocking(move || rx.recv().unwrap())
            .await
            .unwrap();
        assert!(saw_cancel, "compute should see the cancel flag");
    }
}
