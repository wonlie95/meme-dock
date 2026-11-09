// QQ 导出的超大 EIF 是 OLE/CFB 容器的一个变体：DIFAT 链并不完全符合
// 标准库的校验规则。这个轻量读取器按扇区读取，因此不会把整个 EIF 放进内存。
const fs = require('fs');

const FREE = 0xffffffff;
const END = 0xfffffffe;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;

class QQEifReader {
  constructor(filePath) {
    this.fd = fs.openSync(filePath, 'r');
    this.header = this.readAt(0, 512);
    if (!this.header.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new Error('不是 QQ EIF 复合文档');
    }
    if (this.header.readUInt16LE(30) !== 9) throw new Error('不支持的 EIF 扇区大小');
    this.sectorSize = 512;
    this.miniSectorSize = 64;
    this.fatSectorCount = this.header.readUInt32LE(44);
    this.firstDirectorySector = this.header.readUInt32LE(48);
    this.miniStreamCutoff = this.header.readUInt32LE(56);
    this.firstMiniFatSector = this.header.readUInt32LE(60);
    this.miniFatSectorCount = this.header.readUInt32LE(64);
    this.firstDifatSector = this.header.readUInt32LE(68);
    this.fat = this.loadFat();
    this.entries = this.loadDirectory();
    this.root = this.entries.find(entry => entry.type === 5);
    this.miniFat = this.loadMiniFat();
    this.miniStream = this.root ? this.readRegularStream(this.root.startSector, this.root.size) : Buffer.alloc(0);
  }

  readAt(offset, length) {
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(this.fd, buffer, 0, length, offset);
    // QQ 导出的部分 EIF 最后一个扇区不会补齐 512 字节；未写入部分按零填充。
    if (read <= 0) throw new Error('EIF 文件意外结束');
    if (read < length) buffer.fill(0, read);
    return buffer;
  }

  readSector(id) {
    if (!Number.isInteger(id) || id < 0 || id >= this.fat.length + 1024) throw new Error('EIF 扇区索引无效');
    return this.readAt((id + 1) * this.sectorSize, this.sectorSize);
  }

  loadFat() {
    const ids = [];
    for (let i = 0; i < 109; i++) {
      const id = this.header.readUInt32LE(76 + i * 4);
      if (id !== FREE) ids.push(id);
    }
    let difat = this.firstDifatSector;
    const visited = new Set();
    // QQ 的 Header DIFAT 数量字段可能偏大；以 FAT 扇区总数作为可靠上限。
    while (difat !== END && difat !== FREE && !visited.has(difat) && ids.length < this.fatSectorCount) {
      visited.add(difat);
      const sector = this.readAt((difat + 1) * this.sectorSize, this.sectorSize);
      for (let i = 0; i < 127 && ids.length < this.fatSectorCount; i++) {
        const id = sector.readUInt32LE(i * 4);
        if (id !== FREE) ids.push(id);
      }
      difat = sector.readUInt32LE(508);
    }
    if (ids.length < this.fatSectorCount) throw new Error('EIF FAT 表不完整');
    const fat = new Uint32Array(this.fatSectorCount * 128);
    let index = 0;
    for (const id of ids.slice(0, this.fatSectorCount)) {
      const sector = this.readAt((id + 1) * this.sectorSize, this.sectorSize);
      for (let i = 0; i < 128; i++) fat[index++] = sector.readUInt32LE(i * 4);
    }
    return fat;
  }

  chain(start, table = this.fat, limit = table.length) {
    const ids = [];
    const seen = new Set();
    let id = start;
    while (id !== END && id !== FREE && id !== DIFSECT && id !== FATSECT && id < table.length && !seen.has(id) && ids.length < limit) {
      ids.push(id); seen.add(id); id = table[id];
    }
    return ids;
  }

  loadDirectory() {
    const bytes = Buffer.concat(this.chain(this.firstDirectorySector).map(id => this.readSector(id)));
    const entries = [];
    for (let offset = 0; offset + 128 <= bytes.length; offset += 128) {
      const type = bytes[offset + 66];
      if (!type) continue;
      const nameLength = bytes.readUInt16LE(offset + 64);
      const name = nameLength >= 2 ? bytes.subarray(offset, offset + Math.min(64, nameLength - 2)).toString('utf16le') : '';
      entries[offset / 128] = { index: offset / 128, name, type, left: bytes.readUInt32LE(offset + 68), right: bytes.readUInt32LE(offset + 72), child: bytes.readUInt32LE(offset + 76), startSector: bytes.readUInt32LE(offset + 116), size: Number(bytes.readBigUInt64LE(offset + 120)) };
    }
    return entries;
  }

  loadMiniFat() {
    if (this.firstMiniFatSector === END || !this.miniFatSectorCount) return new Uint32Array(0);
    const ids = this.chain(this.firstMiniFatSector).slice(0, this.miniFatSectorCount);
    const fat = new Uint32Array(ids.length * 128);
    let index = 0;
    for (const id of ids) {
      const sector = this.readSector(id);
      for (let i = 0; i < 128; i++) fat[index++] = sector.readUInt32LE(i * 4);
    }
    return fat;
  }

  readRegularStream(startSector, size) {
    const chunks = this.chain(startSector, this.fat, Math.ceil(size / this.sectorSize)).map(id => this.readSector(id));
    return Buffer.concat(chunks, Math.min(size, chunks.length * this.sectorSize)).subarray(0, size);
  }

  readMiniStream(startSector, size) {
    const ids = this.chain(startSector, this.miniFat, Math.ceil(size / this.miniSectorSize));
    const chunks = ids.map(id => this.miniStream.subarray(id * this.miniSectorSize, (id + 1) * this.miniSectorSize));
    return Buffer.concat(chunks, Math.min(size, chunks.length * this.miniSectorSize)).subarray(0, size);
  }

  readStream(entry) {
    if (!entry || entry.type !== 2) throw new Error('EIF 流不存在');
    return entry.size < this.miniStreamCutoff ? this.readMiniStream(entry.startSector, entry.size) : this.readRegularStream(entry.startSector, entry.size);
  }

  imageEntries() {
    const parentByIndex = new Map();
    const visitTree = (index, parent) => {
      if (index === FREE || !this.entries[index]) return;
      const entry = this.entries[index];
      visitTree(entry.left, parent);
      parentByIndex.set(index, parent);
      if (entry.type === 1 || entry.type === 5) visitTree(entry.child, entry.type === 1 ? [...parent, entry.name] : parent);
      visitTree(entry.right, parent);
    };
    if (this.root) visitTree(this.root.child, []);
    return this.entries
      .filter(entry => entry && entry.type === 2 && /\.(?:png|jpe?g|gif|bmp|webp)$/i.test(entry.name) && !/(?:_tmb\.|fix\.)/i.test(entry.name))
      .map(entry => ({ ...entry, groups: parentByIndex.get(entry.index) || [] }));
  }

  close() { if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; } }
}

module.exports = { QQEifReader };
