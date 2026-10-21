// iOS stand-in for ../../logger.js: no log file, messages go to the console, where bridge.js keeps
// warnings/errors for "Share error log" in Settings.
const log = (level, message) => (level === 'error' || level === 'warn' ? console[level] : console.log)(`[${level}] ${message}`);

module.exports = {
  log,
  error: (message, e) => log('error', `${message}${e ? ` ${(e && e.stack) || e}` : ''}`),
  tail: () => [],
  LOG_DIR: '/data/logs',
};
