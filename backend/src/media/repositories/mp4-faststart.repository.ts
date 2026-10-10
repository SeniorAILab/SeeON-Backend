import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const STANDARD_HEADER_BYTES = 8;
const EXTENDED_HEADER_BYTES = 16;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export async function hasFaststartMp4Layout(
  filePath: string,
): Promise<boolean> {
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) {
      return false;
    }
    const faststart = await scanTopLevelBoxes(handle, stat.size);
    return faststart;
  } finally {
    await handle.close();
  }
}

async function scanTopLevelBoxes(
  handle: FileHandle,
  fileSize: number,
): Promise<boolean> {
  const header = Buffer.alloc(EXTENDED_HEADER_BYTES);
  let offset = 0;
  let foundMoov = false;
  while (offset + STANDARD_HEADER_BYTES <= fileSize) {
    const { bytesRead } = await handle.read(
      header,
      0,
      EXTENDED_HEADER_BYTES,
      offset,
    );
    if (bytesRead < STANDARD_HEADER_BYTES) return false;

    const size32 = header.readUInt32BE(0);
    const boxType = header.toString('ascii', 4, 8);
    const boxSize = readBoxSize(header, bytesRead, size32, fileSize - offset);
    if (boxSize === undefined || offset + boxSize > fileSize) return false;

    if (boxType === 'moov') foundMoov = true;
    if (boxType === 'mdat') return foundMoov;
    offset += boxSize;
  }
  return false;
}

function readBoxSize(
  header: Buffer,
  bytesRead: number,
  size32: number,
  remainingBytes: number,
): number | undefined {
  if (size32 === 0) {
    return remainingBytes >= STANDARD_HEADER_BYTES ? remainingBytes : undefined;
  }
  if (size32 === 1) {
    if (bytesRead < EXTENDED_HEADER_BYTES) return undefined;
    const extended = header.readBigUInt64BE(STANDARD_HEADER_BYTES);
    if (extended > MAX_SAFE_BIGINT) return undefined;
    const boxSize = Number(extended);
    return boxSize >= EXTENDED_HEADER_BYTES ? boxSize : undefined;
  }
  return size32 >= STANDARD_HEADER_BYTES ? size32 : undefined;
}
