let data, activeCategory = '全部', editing, draggingId = '';
const $ = selector => document.querySelector(selector);
const grid = $('#grid'), search = $('#search'), editor = $('#editor'), groupsDialog = $('#groups-dialog');

// 将用户输入显示到 HTML 前先转义，避免分组名或标签中的特殊字符破坏页面。
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function categoryKey(category) { return encodeURIComponent(category); }
function categoryFromKey(key) { return decodeURIComponent(key); }
function imageSource(filePath) { return `file:///${filePath.replace(/\\/g, '/')}`; }
function isGif(filePath) { return typeof filePath === 'string' && /\.gif$/i.test(filePath); }
function matches(meme, query) { return [meme.name, ...(meme.tags || [])].join(' ').toLowerCase().includes(query.toLowerCase()); }
async function init() { data = await window.memeAPI.getData(); render(); }

let imageObserver;
function setupLazyImages() {
  imageObserver?.disconnect();
  imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target;
      imageObserver.unobserve(image);
      if (image.dataset.gif === 'true') {
        // GIF 默认显示缓存首帧，鼠标悬停时才装载原动画，列表滚动会更流畅。
        window.memeAPI.getThumbnail(image.dataset.source).then(thumbnail => {
          image.dataset.poster = imageSource(thumbnail);
          if (!image.matches(':hover')) image.src = image.dataset.poster;
        }).catch(() => { image.src = imageSource(image.dataset.source); });
      } else image.src = imageSource(image.dataset.source);
    }
  }, { root: $('.content'), rootMargin: '120px' });
  grid.querySelectorAll('img[data-source]').forEach(image => imageObserver.observe(image));
}

function render() {
  const query = search.value.trim();
  const list = data.memes.filter(meme => (activeCategory === '全部' || meme.category === activeCategory) && matches(meme, query));
  // 仅在一个明确分组、且没有搜索过滤时启用排序，防止把搜索结果误当成完整顺序。
  const canReorder = activeCategory !== '全部' && !query;
  $('#categories').innerHTML = data.categories.map(category => `<button class="${category === activeCategory ? 'active' : ''}" data-category="${categoryKey(category)}">${escapeHtml(category)}</button>`).join('');
  $('#count').textContent = query ? `找到 ${list.length} 个与“${query}”相关的表情` : `${list.length} 个表情`;
  $('#drag-hint').hidden = !canReorder || list.length < 2;
  grid.innerHTML = list.length ? list.map(meme => {
    const title = canReorder ? '点击发送 · 右键编辑 · 拖动排序' : '点击发送 · 右键编辑';
    return `<article class="meme ${canReorder ? 'can-drag' : ''}" data-id="${escapeHtml(meme.id)}" draggable="${canReorder}" title="${title}">${meme.image ? `<img data-source="${escapeHtml(meme.image)}" data-gif="${isGif(meme.image)}"/>` : `<div class="emoji">${escapeHtml(meme.emoji)}</div>`}<span class="tags">${escapeHtml((meme.tags || []).slice(0, 2).join(' · '))}</span><span class="meme-name">${escapeHtml(meme.name)}</span></article>`;
  }).join('') : '<div class="empty">没有找到表情<br/><small>试试其他关键词，或导入新的图片</small></div>';
  setupLazyImages();
}

grid.addEventListener('mouseover', event => {
  const image = event.target.closest('img[data-gif="true"]');
  if (image) image.src = imageSource(image.dataset.source);
});
grid.addEventListener('mouseout', event => {
  const image = event.target.closest('img[data-gif="true"]');
  if (image && image.dataset.poster) image.src = image.dataset.poster;
});
$('#categories').addEventListener('click', event => {
  if (!event.target.dataset.category) return;
  activeCategory = categoryFromKey(event.target.dataset.category);
  render();
});
search.addEventListener('input', render);
grid.addEventListener('click', async event => {
  const item = event.target.closest('.meme');
  if (!item) return;
  try { await window.memeAPI.send(data.memes.find(meme => meme.id === item.dataset.id)); }
  catch (error) { alert(`发送失败：${error.message || error}`); }
});
grid.addEventListener('contextmenu', event => {
  const item = event.target.closest('.meme');
  if (!item) return;
  event.preventDefault();
  openEditor(data.memes.find(meme => meme.id === item.dataset.id));
});

// 下面四个事件负责在同一个分组内保存表情的拖动顺序。
grid.addEventListener('dragstart', event => {
  const item = event.target.closest('.meme[draggable="true"]');
  if (!item) return;
  draggingId = item.dataset.id;
  item.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggingId);
});
grid.addEventListener('dragover', event => {
  const item = event.target.closest('.meme[draggable="true"]');
  if (!item || item.dataset.id === draggingId) return;
  event.preventDefault();
  grid.querySelectorAll('.drop-target').forEach(card => card.classList.remove('drop-target'));
  item.classList.add('drop-target');
  event.dataTransfer.dropEffect = 'move';
});
grid.addEventListener('dragleave', event => event.target.closest('.meme')?.classList.remove('drop-target'));
grid.addEventListener('dragend', () => {
  draggingId = '';
  grid.querySelectorAll('.dragging, .drop-target').forEach(card => card.classList.remove('dragging', 'drop-target'));
});
grid.addEventListener('drop', async event => {
  const target = event.target.closest('.meme[draggable="true"]');
  if (!target || !draggingId || target.dataset.id === draggingId) return;
  event.preventDefault();
  const dragged = data.memes.find(meme => meme.id === draggingId);
  const destination = data.memes.find(meme => meme.id === target.dataset.id);
  if (!dragged || !destination || dragged.category !== destination.category) return;

  // 先从原位置取出，再插到目标前面；保存后下次启动仍按这个顺序显示。
  const sourceIndex = data.memes.findIndex(meme => meme.id === draggingId);
  data.memes.splice(sourceIndex, 1);
  const targetIndex = data.memes.findIndex(meme => meme.id === destination.id);
  data.memes.splice(targetIndex, 0, dragged);
  await window.memeAPI.saveData(data);
  render();
});

$('#import').onclick = async () => {
  const result = await window.memeAPI.importImages();
  if (result.migrated) {
    data = await window.memeAPI.getData(); render();
    alert(`已将 ${result.migrated} 个已导入表情按 QQ 原分组重新归类。`);
  } else if (result.memes.length) {
    data.categories = ['全部', ...new Set([...data.categories.filter(category => category !== '全部'), ...result.categories])];
    data.memes.push(...result.memes);
    await window.memeAPI.saveData(data);
    render();
  }
  if (result.errors.length) alert(`部分文件未导入：\n${result.errors.join('\n')}`);
};

function renderGroups() {
  $('#group-list').innerHTML = data.categories.filter(category => category !== '全部').map(category => {
    const count = data.memes.filter(meme => meme.category === category).length;
    const locked = category === '常用';
    const key = categoryKey(category);
    return `<div class="group-row"><span class="group-name">${escapeHtml(category)}</span><span class="group-count">${count} 个表情</span><button class="rename-group" data-rename-group="${key}" ${locked ? 'disabled title="常用分组不可重命名"' : ''}>重命名</button><button data-remove-group="${key}" ${locked ? 'disabled title="常用分组不可删除"' : ''}>移入常用</button><button class="delete-all" data-delete-all="${key}" ${locked ? 'disabled' : ''}>全部删除</button></div>`;
  }).join('');
}
$('#settings').onclick = () => { renderGroups(); $('#new-group-name').value = ''; groupsDialog.showModal(); $('#new-group-name').focus(); };
$('#close-groups').onclick = () => groupsDialog.close();
$('#add-group').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('#new-group-name').value.trim();
  if (!name) return;
  if (data.categories.includes(name)) return alert('该分组已存在。');
  data.categories.push(name);
  try { await window.memeAPI.saveData(data); }
  catch (error) { data = await window.memeAPI.getData(); return alert(error.message || error); }
  $('#new-group-name').value = ''; renderGroups(); render();
});
$('#group-list').addEventListener('click', async event => {
  const renameKey = event.target.dataset.renameGroup;
  if (renameKey) {
    const oldName = categoryFromKey(renameKey);
    const newName = prompt(`将“${oldName}”重命名为：`, oldName);
    if (newName === null || newName.trim() === oldName) return;
    try {
      data = await window.memeAPI.renameCategory(oldName, newName.trim());
      if (activeCategory === oldName) activeCategory = newName.trim();
      renderGroups(); render();
    } catch (error) { alert(`重命名失败：${error.message || error}`); }
    return;
  }
  const key = event.target.dataset.removeGroup || event.target.dataset.deleteAll;
  if (!key) return;
  const category = categoryFromKey(key);
  const count = data.memes.filter(meme => meme.category === category).length;
  const deleteAll = Boolean(event.target.dataset.deleteAll);
  const message = deleteAll ? `永久删除“${category}”分组及其中 ${count} 个表情？图片文件也会删除，此操作无法恢复。` : `删除“${category}”分组？其中 ${count} 个表情将移动到“常用”。`;
  if (!confirm(message)) return;
  await window.memeAPI.deleteCategory(category, deleteAll);
  data = await window.memeAPI.getData();
  if (activeCategory === category) activeCategory = '全部';
  renderGroups(); render();
});

function openEditor(meme) {
  editing = meme;
  $('#dialog-title').textContent = `编辑：${meme.name}`;
  $('#edit-name').value = meme.name;
  $('#edit-tags').value = (meme.tags || []).join(', ');
  $('#edit-category').innerHTML = data.categories.filter(category => category !== '全部').map(category => `<option ${meme.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('');
  $('#remove').style.display = '';
  editor.showModal();
}
editor.addEventListener('close', async () => {
  if (editor.returnValue !== 'save' || !editing) return;
  editing.name = $('#edit-name').value.trim() || editing.name;
  editing.category = $('#edit-category').value || '常用';
  editing.tags = $('#edit-tags').value.split(/[，,\s]+/).map(tag => tag.trim()).filter(Boolean);
  await window.memeAPI.saveData(data);
  render();
});
$('#remove').onclick = async () => {
  data.memes = data.memes.filter(meme => meme !== editing);
  await window.memeAPI.saveData(data);
  editor.close(); render();
};
init();
