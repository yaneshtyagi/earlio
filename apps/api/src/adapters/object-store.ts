import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Local-disk object store for development and tests. An S3/MinIO implementation replaces it in deployment. */
export class LocalDiskObjectStore implements ObjectStore {
  constructor(private dir: string) {}
  async put(key: string, data: Buffer) {
    const p = join(this.dir, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    return readFile(join(this.dir, key));
  }
}

export interface FileScanner {
  scan(filename: string, data: Buffer): Promise<'clean' | 'infected'>;
}

/** Simulated virus scan: the EICAR test string or a filename containing "eicar" is flagged. */
export class SimFileScanner implements FileScanner {
  async scan(filename: string, data: Buffer) {
    if (/eicar/i.test(filename) || data.toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) return 'infected' as const;
    return 'clean' as const;
  }
}
