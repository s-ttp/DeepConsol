import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

export interface StoredObject {
  key: string;
  bytes: number;
}

export interface Storage {
  put(stream: Buffer | NodeJS.ReadableStream, originalName: string): Promise<StoredObject>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  pathFor(key: string): string;
}

class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  pathFor(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._/-]/g, "_");
    return path.join(this.root, safe);
  }

  async put(input: Buffer | NodeJS.ReadableStream, originalName: string): Promise<StoredObject> {
    const date = new Date().toISOString().slice(0, 10);
    const id = crypto.randomUUID();
    const ext = path.extname(originalName).toLowerCase().slice(0, 16);
    const key = `${date}/${id}${ext}`;
    const full = this.pathFor(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    if (Buffer.isBuffer(input)) {
      await fs.writeFile(full, input);
      return { key, bytes: input.byteLength };
    }
    const fileHandle = await fs.open(full, "w");
    let bytes = 0;
    try {
      for await (const chunk of input) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await fileHandle.write(buf);
        bytes += buf.byteLength;
      }
    } finally {
      await fileHandle.close();
    }
    return { key, bytes };
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }
}

export const storage: Storage = new FsStorage(config.storageFsRoot);
