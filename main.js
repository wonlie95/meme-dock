const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, nativeImage, dialog, screen, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const CFB = require('cfb');
const { QQEifReader } = require('./qq-eif-reader');
const { parseGIF, decompressFrames } = require('gifuct-js');
const { PNG } = require('pngjs');

// 在缺少部分 GPU 运行库的 Windows 环境中使用软件渲染，避免应用启动即退出。
app.disableHardwareAcceleration();

let win;
let previousWindow;
let tray;
let isQuitting = false;
const supported = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// 统一使用随程序打包的图标，避免直接读取 exe 导致 Windows 托盘图标为空。
const iconFile = () => path.join(__dirname, 'assets', 'memedock.ico');
const dataFile = () => path.join(app.getPath('userData'), 'memes.json');
const libraryRoot = () => path.join(app.getPath('userData'), 'library');
const thumbnailRoot = () => path.join(app.getPath('userData'), 'thumbnails');

const initialData = {
  categories: ['全部', '常用', '工作', '反应'],
  memes: [
    { id: 'demo-1', name: '开心鼓掌', emoji: '👏', category: '反应', tags: ['笑', '开心', '鼓掌'] },
    { id: 'demo-2', name: '收到', emoji: '🫡', category: '工作', tags: ['收到', '好的', '工作'] },
    { id: 'demo-3', name: '大笑', emoji: '😂', category: '反应', tags: ['笑', '哈哈', '开心'] },
    { id: 'demo-4', name: '猫猫点赞', emoji: '👍', category: '常用', tags: ['点赞', '好', '可以'] },
    { id: 'demo-5', name: '震惊', emoji: '😮', category: '反应', tags: ['震惊', '啊', '什么'] },
    { id: 'demo-6', name: '加油', emoji: '💪', category: '工作', tags: ['加油', '冲', '支持'] }
  ]
};

function getData() {
  let data;
  try { data = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); }
  catch { data = structuredClone(initialData); }
  // 即使分类暂时没有表情，也保持对应的本地目录存在。
  organizeManagedFiles(data);
  return data;
}
function safeFolderName(name) { return String(name || '未分类').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60) || '未分类'; }
function validateCategoryName(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('请输入分组名称');
  if (clean.length > 60 || safeFolderName(clean) !== clean) {
    throw new Error('分组名称不能包含 \\ / : * ? " < > | 等文件夹不支持的字符');
  }
  return clean;
}
function categoryFolder(category) { const folder = path.join(libraryRoot(), safeFolderName(category)); fs.mkdirSync(folder, { recursive: true }); return folder; }
function uniquePath(folder, name, ext) { let candidate = path.join(folder, `${name}${ext}`), n = 2; while (fs.existsSync(candidate)) candidate = path.join(folder, `${name} (${n++})${ext}`); return candidate; }
function placeInCategory(source, category, preferredName) {
  const ext = path.extname(source).toLowerCase(); const target = uniquePath(categoryFolder(category), safeFolderName(preferredName || path.basename(source, ext)), ext);
  fs.copyFileSync(source, target); return target;
}
function organizeManagedFiles(data) {
  fs.mkdirSync(libraryRoot(), { recursive: true });
  data.categories = ['全部', ...[...new Set((data.categories || []).filter(c => c && c !== '全部'))]];
  data.categories.forEach(categoryFolder);
  for (const meme of data.memes || []) {
    if (!meme.image || !meme.managed || !fs.existsSync(meme.image)) continue;
    const desiredFolder = categoryFolder(meme.category);
    if (path.dirname(meme.image).toLowerCase() !== desiredFolder.toLowerCase()) {
      const target = uniquePath(desiredFolder, safeFolderName(meme.name), path.extname(meme.image));
      fs.renameSync(meme.image, target); meme.image = target;
    }
  }
}
function saveData(data) { organizeManagedFiles(data); fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf8'); }

function createWindow() {
  win = new BrowserWindow({
    width: 920, height: 650, show: false, frame: false, transparent: true,
    // 保留任务栏入口，托盘图标同时方便快速呼出或退出软件。
    alwaysOnTop: true, skipTaskbar: false, resizable: false, icon: iconFile(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile('index.html');
  // 首次双击启动时直接展示，之后可通过全局快捷键再次呼出。
  win.once('ready-to-show', () => win.show());
  win.on('close', event => {
    if (isQuitting) return;
    event.preventDefault(); win.hide();
  });
}

function createTray() {
  // 使用 .ico 文件创建通知区域图标；Windows 右下角可通过此图标管理程序。
  const icon = nativeImage.createFromPath(iconFile());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('MemeDock 表情包快捷发送');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 MemeDock', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => togglePanel());
  // 有些 Windows 主题只在显式处理后才显示右键菜单。
  tray.on('right-click', () => tray.popUpContextMenu());
}

function togglePanel() {
  if (!win) return;
  if (win.isVisible()) return win.hide();
  previousWindow = BrowserWindow.getFocusedWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor).workArea;
  win.setPosition(Math.max(display.x + 12, Math.min(cursor.x - 420, display.x + display.width - 920)), Math.max(display.y + 12, cursor.y - 54));
  win.show(); win.focus();
}

app.whenReady().then(() => {
  // 给 Windows 一个稳定的应用标识，让任务栏与通知区域正确关联图标。
  app.setAppUserModelId('com.memodock.desktop');
  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Shift+Space', togglePanel);
  app.on('activate', () => !win.isDestroyed() && win.show());
}).catch(error => {
  // 将打包版的启动异常写入用户数据目录，便于定位无控制台环境中的问题。
  fs.writeFileSync(path.join(app.getPath('userData'), 'startup-error.log'), error?.stack || String(error));
});
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.handle('get-data', () => getData());
ipcMain.handle('save-data', (_, data) => { saveData(data); return data; });
function makeMeme(image, category, name, tags = []) { return { id: `m-${Date.now()}-${Math.random().toString(36).slice(2)}`, name, image, category, tags: [...new Set(tags.filter(Boolean))], managed: true }; }
function readStrings(buffer) {
  const strings = new Set();
  for (const text of [buffer.toString('utf8'), buffer.toString('utf16le')]) {
    for (const value of text.matchAll(/[\u4e00-\u9fffA-Za-z0-9_\-]{2,40}/g)) strings.add(value[0]);
  }
  return [...strings].filter(x => !/^(root|objectpool|compobj|summaryinformation)$/i.test(x));
}
function extractImages(buffer) {
  const results = [];
  for (let i = 0; i < buffer.length - 12; i++) {
    let end = -1, ext = '';
    if (buffer[i] === 0x89 && buffer.subarray(i, i + 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { end = buffer.indexOf(Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]), i + 8); if (end >= 0) { end += 12; ext = '.png'; } }
    else if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) { end = buffer.indexOf(Buffer.from([0xff,0xd9]), i + 3); if (end >= 0) { end += 2; ext = '.jpg'; } }
    else if (buffer.subarray(i, i + 6).toString() === 'GIF87a' || buffer.subarray(i, i + 6).toString() === 'GIF89a') { end = buffer.indexOf(0x3b, i + 6); if (end >= 0) { end++; ext = '.gif'; } }
    if (end > i) { results.push({ ext, bytes: buffer.subarray(i, end) }); i = end - 1; }
  }
  return results;
}
function importEif(source) {
  let reader;
  try { reader = new QQEifReader(source); } catch (error) { throw new Error(`无法读取 QQ EIF：${error.message}`); }
  try {
    const entries = reader.imageEntries();
    if (!entries.length) throw new Error('EIF 内未找到可导入的图片流');
    const packageName = safeFolderName(path.basename(source, '.eif'));
    const categoryFor = entry => `${packageName} · QQ 分组 ${entry.groups.at(-1) || '未分类'}`;
    const categories = [...new Set(entries.map(categoryFor))];
    // 已由旧版本导入过同一 EIF 时，按文件名重新归类并移动已有文件，避免重复复制数千张图片。
    const existing = getData();
    const oldMemes = existing.memes.filter(meme => meme.category === packageName && meme.image);
    if (oldMemes.length) {
      const categoryByFile = new Map(entries.map(entry => [entry.name.toLowerCase(), categoryFor(entry)]));
      let migrated = 0;
      for (const meme of oldMemes) {
        const file = path.basename(meme.image).replace(/ \(\d+\)(?=\.[^.]+$)/, '').toLowerCase();
        const category = categoryByFile.get(file);
        if (category) { meme.category = category; migrated++; }
      }
      existing.categories = ['全部', ...new Set([...existing.categories.filter(c => c !== '全部' && c !== packageName), ...categories])];
      saveData(existing);
      return { categories, memes: [], migrated };
    }
    const memes = entries.map((entry, index) => {
      const category = categoryFor(entry);
      const folder = categoryFolder(category);
      const ext = path.extname(entry.name).toLowerCase();
      const name = safeFolderName(path.basename(entry.name, ext)) || `表情 ${index + 1}`;
      const destination = uniquePath(folder, name, ext);
      fs.writeFileSync(destination, reader.readStream(entry));
      return makeMeme(destination, category, name, [name]);
    });
    return { categories, memes, migrated: 0 };
  } finally { reader.close(); }
}
ipcMain.handle('import-images', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: '表情图片或 QQ 表情包', extensions: [...supported, '.eif'].map(x => x.slice(1)) }] });
  if (canceled) return { memes: [], categories: [], errors: [] };
  const result = { memes: [], categories: [], errors: [], migrated: 0 };
  for (const source of filePaths) try {
    if (path.extname(source).toLowerCase() === '.eif') { const imported = importEif(source); result.memes.push(...imported.memes); result.categories.push(...imported.categories); result.migrated += imported.migrated || 0; }
    else if (supported.has(path.extname(source).toLowerCase())) { const category = '常用', ext = path.extname(source); result.memes.push(makeMeme(placeInCategory(source, category, path.basename(source, ext)), category, path.basename(source, ext))); }
  } catch (error) { result.errors.push(`${path.basename(source)}：${error.message}`); }
  return result;
});
function runPowerShell(command) {
  return new Promise((resolve, reject) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', command], error => error ? reject(error) : resolve()));
}
function gifClipboardPayload(filePath) {
  const bytes = fs.readFileSync(filePath);
  const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const frame = decompressFrames(gif, true)[0];
  if (!frame) throw new Error('GIF 中没有可用图像帧');
  const patch = Buffer.from(frame.patch);
  const width = gif.lsd.width, height = gif.lsd.height;
  const rgba = Buffer.alloc(width * height * 4);
  for (let row = 0; row < frame.dims.height; row++) {
    const source = row * frame.dims.width * 4;
    const target = ((frame.dims.top + row) * width + frame.dims.left) * 4;
    patch.copy(rgba, target, source, source + frame.dims.width * 4);
  }
  // PNG 编码保留 RGBA 颜色顺序；Windows 的 createFromBitmap 使用 BGRA，
  // 直接传 RGBA 会产生红蓝通道互换的偏色。
  const image = nativeImage.createFromBuffer(PNG.sync.write({ width, height, data: rgba }));
  // 避免把完整 GIF 编成巨大的 Base64 文本；大动图可能导致 QQ 读取剪贴板失败。
  const fileUrl = new URL(`file:///${filePath.replace(/\\/g, '/')}`).href;
  return { image, html: `<img src="${fileUrl}" />` };
}
function gifThumbnail(filePath) {
  const stat = fs.statSync(filePath);
  const key = Buffer.from(`${filePath}|${stat.size}|${stat.mtimeMs}`).toString('base64url');
  const output = path.join(thumbnailRoot(), `${key}.png`);
  if (!fs.existsSync(output)) {
    fs.mkdirSync(thumbnailRoot(), { recursive: true });
    // 缓存 GIF 首帧缩略图，列表滚动时无需反复解码完整动画。
    const image = gifClipboardPayload(filePath).image.resize({ width: 160, height: 160, quality: 'good' });
    fs.writeFileSync(output, image.toPNG());
  }
  return output;
}
ipcMain.handle('get-thumbnail', (_, filePath) => {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.gif' || !fs.existsSync(filePath)) return filePath;
  return gifThumbnail(filePath);
});
ipcMain.handle('send-meme', async (_, meme) => {
  // QQ 会将 FileDrop 剪贴板格式作为“文件上传”。统一写入图片位图格式，
  // QQ 才会在聊天编辑区生成图片消息，而不是附件消息。
  if (meme.image) {
    const isGif = path.extname(meme.image).toLowerCase() === '.gif';
    const payload = isGif ? gifClipboardPayload(meme.image) : null;
    const image = payload ? payload.image : nativeImage.createFromPath(meme.image);
    if (image.isEmpty()) throw new Error('无法读取该图片');
    // QQ 支持富文本时将优先使用原始 GIF，保留动画；不支持时退回 PNG 首帧图片。
    if (payload) {
      clipboard.clear();
      clipboard.write({ html: payload.html, image });
      // 验证图片回退确实进入剪贴板，失败时再单独写入位图。
      if (clipboard.readImage().isEmpty()) {
        clipboard.writeImage(image);
        if (clipboard.readImage().isEmpty()) throw new Error('GIF 无法写入系统剪贴板');
      }
    }
    else clipboard.writeImage(image);
  }
  else clipboard.writeText(meme.emoji || meme.name);
  win.hide();
  if (previousWindow && !previousWindow.isDestroyed()) previousWindow.focus();
  // 将 Ctrl+V 发给隐藏面板前的前台应用；部分以管理员身份运行的软件会阻止该模拟输入。
  setTimeout(() => runPowerShell("$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('^v')").catch(() => {}), 180);
  return true;
});
ipcMain.handle('delete-category', (_, category, deleteMemes) => {
  if (!category || category === '全部' || category === '常用') throw new Error('该分组不能删除');
  const data = getData(); const targets = data.memes.filter(meme => meme.category === category);
  if (deleteMemes) {
    const root = path.resolve(libraryRoot()).toLowerCase();
    for (const meme of targets) if (meme.image) { const imagePath = path.resolve(meme.image); if (imagePath.toLowerCase().startsWith(`${root}${path.sep}`) && fs.existsSync(imagePath)) fs.unlinkSync(imagePath); }
    data.memes = data.memes.filter(meme => meme.category !== category);
  } else for (const meme of targets) meme.category = '常用';
  data.categories = data.categories.filter(item => item !== category); saveData(data);
  return { moved: deleteMemes ? 0 : targets.length, deleted: deleteMemes ? targets.length : 0 };
});
ipcMain.handle('rename-category', (_, oldName, newName) => {
  if (!oldName || oldName === '全部' || oldName === '常用') throw new Error('“全部”和“常用”是系统分组，不能重命名');
  const cleanName = validateCategoryName(newName);
  const data = getData();
  if (!data.categories.includes(oldName)) throw new Error('未找到要重命名的分组');
  if (data.categories.includes(cleanName)) throw new Error('已存在同名分组');

  // 本地库按分组存放图片：优先直接重命名文件夹，文件资源不会被重新复制。
  const oldFolder = path.join(libraryRoot(), safeFolderName(oldName));
  const newFolder = path.join(libraryRoot(), safeFolderName(cleanName));
  if (oldFolder.toLowerCase() !== newFolder.toLowerCase() && fs.existsSync(oldFolder) && !fs.existsSync(newFolder)) {
    fs.renameSync(oldFolder, newFolder);
    // 文件夹改名后，同步保存的图片绝对路径，否则下次打开会找不到原图。
    const oldPrefix = `${path.resolve(oldFolder).toLowerCase()}${path.sep}`;
    for (const meme of data.memes) {
      const imagePath = meme.image && path.resolve(meme.image);
      if (meme.managed && imagePath && imagePath.toLowerCase().startsWith(oldPrefix)) {
        meme.image = path.join(newFolder, path.relative(oldFolder, imagePath));
      }
    }
  }
  data.categories = data.categories.map(category => category === oldName ? cleanName : category);
  data.memes.forEach(meme => { if (meme.category === oldName) meme.category = cleanName; });
  saveData(data);
  // 如果新文件夹本来就存在，saveData 会移动图片；这时顺手清理旧的空文件夹。
  if (fs.existsSync(oldFolder) && fs.readdirSync(oldFolder).length === 0) fs.rmdirSync(oldFolder);
  return data;
});
