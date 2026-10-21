// server.js only touches electron for app.getPath('downloads'); resolveDownloadDir() wins first anyway.
module.exports = { app: { getPath: () => '/data/Downloads' } };
