import { BadRequestException } from '@nestjs/common';

export async function readRequestBody(
  req: AsyncIterable<Buffer | string>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer: Uint8Array =
      typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new BadRequestException('Snapshot exceeds size limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
