// iOS stand-in for ../../tools.js: there are no yt-dlp/ffmpeg binaries to install on iOS,
// the in-app extractor replaces them, so the tools are always "ready".
const READY = { ytDlp: true, ffmpeg: true, progress: { status: 'done', tool: '', percent: 100, error: '' } };
module.exports = {
  toolsStatus: () => READY,
  ensureTools: async () => {},
  updateYtDlpIfManaged: async () => {},
  expectedHash: () => null, ytDlpAsset: () => null, ffmpegAsset: () => null,
};
