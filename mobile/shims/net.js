// `net.isIP` for the iOS/Android build (server.js uses it for its SSRF checks).
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const V6 = /^(([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(([0-9a-f]{1,4}:){0,7}[0-9a-f]{0,4})?::(([0-9a-f]{1,4}:){0,7}[0-9a-f]{0,4})?|::ffff:\d+\.\d+\.\d+\.\d+)$/i;
const isIP = (s) => (V4.test(String(s)) ? 4 : V6.test(String(s)) ? 6 : 0);
module.exports = { isIP, isIPv4: (s) => isIP(s) === 4, isIPv6: (s) => isIP(s) === 6 };
