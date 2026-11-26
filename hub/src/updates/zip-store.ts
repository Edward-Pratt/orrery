// `StoreZip`: a zip written as it goes, its entries stored (no compression: a mod is a zip already), for the mods zip
// (`mods-zip.ts`). `entry(name, data)` gives the bytes of one entry (its local header and data), `end()` the central
// directory and its end record. No zip64: an archive past 4 GiB, or more than 65535 entries, throws. Hub core.

import { crc32 } from 'node:zlib';

const MAX = 0xffffffff;
/** 1980-01-01 00:00, the zip's oldest date: the entries say no time of their own. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export class StoreZip {
  #offset = 0;
  #central: Buffer[] = [];

  /** One stored entry: its local header, then `data`. */
  entry(name: string, data: Uint8Array): Buffer[] {
    const file = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    if (this.#central.length >= 0xffff || this.#offset + 30 + file.length + data.byteLength > MAX) throw new Error('The zip would be over 4 GiB.');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names in UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    local.copy(central, 6, 4, 30); // version needed .. name length
    central.writeUInt32LE(this.#offset, 42);
    this.#central.push(central, file);
    this.#offset += 30 + file.length + data.byteLength;
    return [local, file, Buffer.from(data.buffer, data.byteOffset, data.byteLength)];
  }

  /** The central directory and its end record: the last bytes of the zip. */
  end(): Buffer {
    const dir = Buffer.concat(this.#central);
    if (this.#offset + dir.length + 22 > MAX) throw new Error('The zip would be over 4 GiB.');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.#central.length / 2, 8);
    eocd.writeUInt16LE(this.#central.length / 2, 10);
    eocd.writeUInt32LE(dir.length, 12);
    eocd.writeUInt32LE(this.#offset, 16);
    return Buffer.concat([dir, eocd]);
  }
}
