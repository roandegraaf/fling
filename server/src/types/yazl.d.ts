/**
 * yazl 3.x ships no types and DefinitelyTyped's @types/yazl still describes 2.x
 * (no addReadStreamLazy, different end() signature). This declares only what we
 * actually use, matching yazl 3.3.
 */
declare module 'yazl' {
  import type { Readable } from 'node:stream';
  import type { EventEmitter } from 'node:events';

  interface EntryOptions {
    mtime?: Date;
    mode?: number;
    compress?: boolean;
    forceZip64Format?: boolean;
    fileComment?: string;
    size?: number;
  }

  interface EndOptions {
    forceZip64Format?: boolean;
  }

  type LazyStreamCallback = (err: Error | null, stream?: Readable) => void;

  export class ZipFile extends EventEmitter {
    outputStream: Readable;
    addFile(realPath: string, metadataPath: string, options?: EntryOptions): void;
    addReadStream(readStream: Readable, metadataPath: string, options?: EntryOptions): void;
    addReadStreamLazy(
      metadataPath: string,
      options: EntryOptions,
      getStream: (cb: LazyStreamCallback) => void,
    ): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: EntryOptions): void;
    addEmptyDirectory(metadataPath: string, options?: EntryOptions): void;
    end(calculatedTotalSizeCallback?: (totalSize: number) => void): void;
    end(options: EndOptions, calculatedTotalSizeCallback?: (totalSize: number) => void): void;
  }

  const _default: { ZipFile: typeof ZipFile };
  export default _default;
}
