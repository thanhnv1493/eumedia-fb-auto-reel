const { app, BrowserWindow } = require('electron');
const path = require('path');

require('./server');

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    autoHideMenuBar: true,
    title: 'ÊU Auto',
    icon: path.join(__dirname, 'public', 'assets', 'eu-media-logo.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  window.loadURL('http://localhost:3000');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
