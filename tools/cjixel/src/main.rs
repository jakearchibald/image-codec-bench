//! cjixel IN.png OUT.jxl (-q QUALITY | --lossless) -s SPEED [-j THREADS] [--patches]
//! cjixel IN.jpg OUT.jxl --jpeg -s SPEED [-j THREADS] [--jpeg-reconstruction]
//!
//! QUALITY is jixel's libjpeg-like 0..100 scale (`EncodeConfig::with_quality`).
//! SPEED is 1..6: UltraFast, Fastest, Fast (jixel's default), Medium, Slow,
//! ExtraSlow -- higher is slower, like cjxl -e. THREADS 0 means all cores.
//! `--patches` turns on jixel's patch dictionary (off by default).
//!
//! `--jpeg` transcodes a JPEG losslessly (its DCT coefficients, so the same
//! pixels at every speed; speed only changes the entropy coding). Without
//! `--jpeg-reconstruction` there is no `jbrd` box, so the original JPEG bytes
//! can't be rebuilt -- as `cjxl --allow_jpeg_reconstruction=0`.
//!
//! Input is what the bench hands an encoder: an 8-bit RGB/RGBA PNG (sRGB), or
//! a 16-bit RGB PNG whose cICP chunk says PQ in sRGB, Display P3 or BT.2020
//! primaries (the HDR reference), which is declared as such in the JXL.

use jixel::{
    ColorEncoding, EncodeConfig, JpegTranscodeConfig, Primaries, RenderingIntent, Speed, TransferFunction, WhitePoint,
};
use std::process::ExitCode;

const SPEEDS: [Speed; 6] = [Speed::UltraFast, Speed::Fastest, Speed::Fast, Speed::Medium, Speed::Slow, Speed::ExtraSlow];

/// H.273 transfer characteristic for PQ.
const CICP_PQ: u8 = 16;
/// PQ's reference peak, which cjxl also signals for PQ input.
const PQ_PEAK_NITS: f32 = 10000.0;

fn usage() -> ExitCode {
    eprintln!(
        "usage: cjixel IN.png OUT.jxl (-q QUALITY | --lossless) -s SPEED(1-6) [-j THREADS] [--patches]\n       \
         cjixel IN.jpg OUT.jxl --jpeg -s SPEED(1-6) [-j THREADS] [--jpeg-reconstruction]\n       cjixel --version"
    );
    ExitCode::from(2)
}

fn fail(message: String) -> ExitCode {
    eprintln!("cjixel: {message}");
    ExitCode::FAILURE
}

/// The JXL colour encoding for PQ in the given H.273 primaries.
fn pq_encoding(cicp_primaries: u8) -> Option<ColorEncoding> {
    let primaries = match cicp_primaries {
        1 => Primaries::Bt709,
        9 => Primaries::Bt2020,
        // H.273's 12 is Display P3 (D65). JXL has one P3 enumerant and takes
        // the white point separately, as jixel's own display_p3() does.
        12 => Primaries::Smpte431,
        _ => return None,
    };
    Some(ColorEncoding {
        white_point: WhitePoint::D65,
        primaries,
        transfer: TransferFunction::Smpte2084,
        rendering_intent: RenderingIntent::Relative,
    })
}

fn transcode_jpeg(input: &str, output: &str, speed: Speed, threads: usize, reconstruction: bool) -> ExitCode {
    let bytes = match std::fs::read(input) {
        Ok(bytes) => bytes,
        Err(error) => return fail(format!("{input}: {error}")),
    };
    // The default config uses every core; -j narrows it.
    let mut config = JpegTranscodeConfig::default().with_speed(speed).with_jpeg_reconstruction(reconstruction);
    if threads > 0 {
        config = config.with_num_threads(threads);
    }
    match jixel::encode_jpeg_lossless_with_config(&bytes, &config) {
        Ok(jxl) => match std::fs::write(output, jxl) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => fail(format!("{output}: {error}")),
        },
        Err(error) => fail(format!("{input}: {error:?}")),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--version") {
        println!("cjixel: jixel {} (git {})", env!("JIXEL_VERSION"), env!("JIXEL_REV"));
        return ExitCode::SUCCESS;
    }
    let (mut positional, mut quality, mut speed, mut threads) = (Vec::new(), None, None, 0usize);
    let (mut lossless, mut patches, mut jpeg, mut reconstruction) = (false, false, false, false);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-q" => quality = it.next().and_then(|v| v.parse::<f32>().ok()),
            "-s" => speed = it.next().and_then(|v| v.parse::<usize>().ok()),
            "-j" => threads = match it.next().and_then(|v| v.parse().ok()) { Some(n) => n, None => return usage() },
            "--lossless" => lossless = true,
            "--patches" => patches = true,
            "--jpeg" => jpeg = true,
            "--jpeg-reconstruction" => reconstruction = true,
            _ => positional.push(arg),
        }
    }
    let (Some(speed), [input, output]) = (speed, positional.as_slice()) else {
        return usage();
    };
    let Some(&speed) = speed.checked_sub(1).and_then(|i| SPEEDS.get(i)) else {
        eprintln!("cjixel: -s must be 1..6");
        return ExitCode::from(2);
    };
    if jpeg {
        if quality.is_some() || lossless || patches {
            return usage();
        }
        return transcode_jpeg(input, output, speed, threads, reconstruction);
    }
    if quality.is_some() == lossless || reconstruction {
        return usage();
    }

    let file = match std::fs::File::open(input) {
        Ok(file) => file,
        Err(error) => return fail(format!("{input}: {error}")),
    };
    let mut reader = match png::Decoder::new(std::io::BufReader::new(file)).read_info() {
        Ok(reader) => reader,
        Err(error) => return fail(format!("{input}: {error}")),
    };
    let cicp = reader.info().coding_independent_code_points;
    let mut pixels = vec![0; reader.output_buffer_size().expect("PNG size")];
    let info = match reader.next_frame(&mut pixels) {
        Ok(info) => info,
        Err(error) => return fail(format!("{input}: {error}")),
    };
    pixels.truncate(info.buffer_size());

    let threads = if threads == 0 { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) } else { threads };
    let mut config = EncodeConfig::default()
        .with_lossless(lossless)
        .with_speed(speed)
        .with_patches(patches)
        .with_num_threads(threads);
    if let Some(quality) = quality {
        config = config.with_quality(quality);
    }
    let (w, h) = (info.width as usize, info.height as usize);

    let encoded = match (info.bit_depth, info.color_type) {
        (png::BitDepth::Eight, png::ColorType::Rgb) => jixel::encode_image(&pixels, w, h, &config),
        (png::BitDepth::Eight, png::ColorType::Rgba) => jixel::encode_image_with_alpha(&pixels, w, h, &config),
        (png::BitDepth::Sixteen, png::ColorType::Rgb) => {
            let Some(cicp) = cicp.filter(|c| c.transfer_function == CICP_PQ) else {
                return fail("16-bit input must be PQ, stated by a cICP chunk".into());
            };
            let Some(encoding) = pq_encoding(cicp.color_primaries) else {
                return fail(format!("unsupported cICP primaries {} (expected 1, 9 or 12)", cicp.color_primaries));
            };
            config = config.with_color_encoding(encoding).with_intensity_target(PQ_PEAK_NITS);
            // PNG stores 16-bit samples big-endian.
            let samples: Vec<u16> = pixels.chunks_exact(2).map(|b| u16::from_be_bytes([b[0], b[1]])).collect();
            jixel::encode_image_16bit(&samples, w, h, &config)
        }
        (depth, colour) => return fail(format!("unsupported PNG: {depth:?} {colour:?}")),
    };
    match encoded {
        Ok(bytes) => match std::fs::write(output, bytes) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => fail(format!("{output}: {error}")),
        },
        Err(error) => fail(format!("{error:?}")),
    }
}
