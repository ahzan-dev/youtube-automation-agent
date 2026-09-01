const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let cachedPath = null;

/**
 * Resolve the FFmpeg binary to use, in order of preference:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled binary from the optional ffmpeg-static package
 * 3. `ffmpeg` on the system PATH
 */
function getFFmpegPath() {
  if (cachedPath) {
    return cachedPath;
  }

  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }

  try {
    cachedPath = require('ffmpeg-static');
  } catch (error) {
    cachedPath = null;
  }

  cachedPath = cachedPath || 'ffmpeg';
  return cachedPath;
}

async function checkFFmpeg() {
  try {
    await execFileAsync(getFFmpegPath(), ['-version']);
    return true;
  } catch (error) {
    return false;
  }
}

async function runFFmpeg(args) {
  return execFileAsync(getFFmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Measure a media file's duration in seconds by decoding it to the null muxer.
 * Uses ffmpeg (not ffprobe) so it works with the bundled ffmpeg-static binary.
 * Returns null when the duration cannot be determined.
 */
async function probeDurationSeconds(filePath) {
  try {
    const { stderr } = await execFileAsync(
      getFFmpegPath(),
      ['-v', 'info', '-nostats', '-i', filePath, '-f', 'null', '-'],
      { maxBuffer: 32 * 1024 * 1024 }
    );
    const text = String(stderr || '');
    // Prefer the container header; fall back to the decoded length.
    const header = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (header) {
      return Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3]);
    }
    const times = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (times.length) {
      const last = times[times.length - 1];
      return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
    }
  } catch (error) {
    // fall through
  }
  return null;
}

function ffmpegInstallHint() {
  const hints = {
    win32: 'winget install Gyan.FFmpeg (then restart your terminal)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg (or your distro equivalent)'
  };

  const platformHint = hints[process.platform] || 'https://ffmpeg.org/download.html';
  return `FFmpeg not found. Install it with: ${platformHint} — or run "npm install" again to fetch the bundled ffmpeg-static binary, or set FFMPEG_PATH to your ffmpeg executable.`;
}

module.exports = { getFFmpegPath, checkFFmpeg, runFFmpeg, probeDurationSeconds, ffmpegInstallHint };
