//! hdr-ssim2 <reference.png> <distorted.png> --primaries srgb|p3|bt2020 [--bits N]
//! hdr-ssim2 --peak <image.png>
//!
//! Both inputs must be 16-bit RGB PNGs carrying PQ-encoded values. The caller
//! (src/score.js) checks each file's cICP chunk and passes the primaries, so
//! colour signalling is asserted in one place rather than trusted here.
//!
//! PQ is absolute, so decoding it yields cd/m² directly -- which is exactly
//! what `compute_ssimulacra2_pu_nits` wants. The metric's opsin matrix assumes
//! linear sRGB primaries, so wider-gamut input is converted to BT.709 in
//! linear light first. Out-of-gamut components go negative; the metric clamps
//! after its LMS mix, the same point it would for any other input.
//!
//! `--bits N` rounds both images' PQ code values to N bits before scoring, to
//! model what an N-bit display pipeline shows. Rounding both matters:
//! SSIMULACRA2 is extremely steep near 100 (one code value changed by 1 in a
//! 16-bit image already scores ~96.7), so rounding only the reference would
//! cost every decode the same large penalty for being at a different depth.
//!
//! `--peak` prints the brightest channel value in the image, in cd/m².

use std::fs::File;
use std::io::BufReader;
use std::process::ExitCode;

use fast_ssim2::{LinearRgbImage, compute_ssimulacra2_pu_nits};

/// Linear RGB -> linear BT.709, row-major.
type Matrix = [[f32; 3]; 3];

const IDENTITY: Matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
const P3_TO_709: Matrix = [
    [1.224_940_2, -0.224_940_4, 0.0],
    [-0.042_056_955, 1.042_057_1, 0.0],
    [-0.019_637_555, -0.078_636_05, 1.098_273_6],
];
const BT2020_TO_709: Matrix = [
    [1.660_491, -0.587_641_1, -0.072_849_9],
    [-0.124_550_5, 1.132_899_9, -0.008_349_4],
    [-0.018_150_8, -0.100_578_9, 1.118_729_7],
];

/// SMPTE ST 2084 EOTF: code value in [0, 1] -> cd/m².
fn pq_to_nits(e: f32) -> f32 {
    const M1: f32 = 2610.0 / 16384.0;
    const M2: f32 = 2523.0 / 4096.0 * 128.0;
    const C1: f32 = 3424.0 / 4096.0;
    const C2: f32 = 2413.0 / 4096.0 * 32.0;
    const C3: f32 = 2392.0 / 4096.0 * 32.0;
    let p = e.powf(1.0 / M2);
    10000.0 * ((p - C1).max(0.0) / (C2 - C3 * p)).powf(1.0 / M1)
}

/// 16-bit PQ code values, row-major RGB, plus dimensions.
fn read_pq(path: &str) -> Result<(Vec<u16>, usize, usize), String> {
    let file = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    let decoder = png::Decoder::new(BufReader::new(file));
    let mut reader = decoder.read_info().map_err(|e| format!("{path}: {e}"))?;
    let (colour, depth) = reader.output_color_type();
    if colour != png::ColorType::Rgb || depth != png::BitDepth::Sixteen {
        return Err(format!("{path}: expected 16-bit RGB, got {colour:?} {depth:?}"));
    }
    let mut buffer = vec![0u8; reader.output_buffer_size().ok_or("image too large")?];
    let info = reader.next_frame(&mut buffer).map_err(|e| format!("{path}: {e}"))?;
    let (width, height) = (info.width as usize, info.height as usize);
    let codes = buffer[..info.buffer_size()]
        .chunks_exact(2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .collect();
    Ok((codes, width, height))
}

/// Round a 16-bit code value to `bits` bits, keeping the 16-bit scale.
fn requantise(code: u16, bits: u32) -> u16 {
    if bits >= 16 {
        return code;
    }
    let levels = f64::from((1u32 << bits) - 1);
    let q = (f64::from(code) / 65535.0 * levels).round();
    (q / levels * 65535.0).round() as u16
}

fn load(path: &str, matrix: &Matrix, bits: u32) -> Result<LinearRgbImage, String> {
    let (codes, width, height) = read_pq(path)?;

    // 65,536-entry table: PQ's two powf calls per channel would otherwise
    // dominate the load for a multi-megapixel image.
    let lut: Vec<f32> = (0..=u16::MAX)
        .map(|v| pq_to_nits(f32::from(requantise(v, bits)) / 65535.0))
        .collect();

    let data = codes
        .chunks_exact(3)
        .map(|px| {
            let (r, g, b) = (lut[usize::from(px[0])], lut[usize::from(px[1])], lut[usize::from(px[2])]);
            let m = matrix;
            [
                m[0][0] * r + m[0][1] * g + m[0][2] * b,
                m[1][0] * r + m[1][1] * g + m[1][2] * b,
                m[2][0] * r + m[2][1] * g + m[2][2] * b,
            ]
        })
        .collect();
    Ok(LinearRgbImage::new(data, width, height))
}

const USAGE: &str = "usage: hdr-ssim2 <reference.png> <distorted.png> --primaries srgb|p3|bt2020 [--bits N]\n       hdr-ssim2 --peak <image.png>";

fn run() -> Result<String, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.first().map(String::as_str) == Some("--peak") {
        let [_, path] = args.as_slice() else {
            return Err(USAGE.into());
        };
        let (codes, _, _) = read_pq(path)?;
        let max = codes.iter().copied().max().unwrap_or(0);
        return Ok(format!("{:.3}", pq_to_nits(f32::from(max) / 65535.0)));
    }

    let mut positional = Vec::new();
    let mut primaries = None;
    let mut bits = 16;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--primaries" => primaries = iter.next().cloned(),
            "--bits" => {
                bits = iter
                    .next()
                    .and_then(|b| b.parse::<u32>().ok())
                    .filter(|b| (1..=16).contains(b))
                    .ok_or_else(|| format!("--bits needs a value in 1..=16\n{USAGE}"))?;
            }
            _ => positional.push(arg.clone()),
        }
    }
    let [reference, distorted] = positional.as_slice() else {
        return Err(USAGE.into());
    };
    let matrix = match primaries.as_deref() {
        Some("srgb") => &IDENTITY,
        Some("p3") => &P3_TO_709,
        Some("bt2020") => &BT2020_TO_709,
        Some(other) => return Err(format!("unknown primaries '{other}'\n{USAGE}")),
        None => return Err(format!("--primaries is required\n{USAGE}")),
    };
    let a = load(reference, matrix, bits)?;
    let b = load(distorted, matrix, bits)?;
    let score = compute_ssimulacra2_pu_nits(a, b).map_err(|e| format!("{e}"))?;
    Ok(format!("{score:.8}"))
}

fn main() -> ExitCode {
    match run() {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
