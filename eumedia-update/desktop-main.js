const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const { startupAssetsReady } = require('./server');

function createWindow() {
  const icoIcon = path.join(__dirname, 'public', 'assets', 'eu-media-logo.ico');
  const pngIcon = path.join(__dirname, 'public', 'assets', 'eu-media-logo.png');
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    autoHideMenuBar: true,
    title: 'ÊU Auto',
    icon: fs.existsSync(icoIcon) ? icoIcon : pngIcon,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  window.loadURL('http://localhost:3000');
}

app.whenReady().then(async () => {
  await Promise.race([startupAssetsReady, new Promise(resolve => setTimeout(resolve, 6_000))]);
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
