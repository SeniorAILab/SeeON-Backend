import type { EdgeTopologyHarness } from './edge-topology-harness.js';
import { PRODUCT_ROOM_ID, topologyBody } from './edge-topology-harness.js';
import {
  readArray,
  readObject,
  readObjectField,
  readString,
} from './json-response.js';

export type TransferFixture = {
  readonly digest: string;
  readonly items: readonly TransferItem[];
};

type TransferItem = {
  readonly kind: 'FLOOR' | 'ROOM' | 'CAMERA';
  readonly edgeRef: string;
  readonly canonicalId: string;
  readonly parentCanonicalId: string | null;
};

export async function aliasSnapshot(
  harness: EdgeTopologyHarness,
): Promise<TransferFixture> {
  await harness.seedProductTopology();
  const body = topologyBody();
  body.floors[0].rooms[0].legacyCanonicalSpaceId = PRODUCT_ROOM_ID;
  const response = readObject(
    (await harness.put(body).expect(200)).body,
    'alias snapshot',
  );
  const transfer = readObjectField(response, 'ownershipTransferRequired');
  return {
    digest: readString(transfer.manifestDigest, 'manifestDigest'),
    items: readArray(transfer.items, 'items').map(readTransferItem),
  };
}

function readTransferItem(value: unknown): TransferItem {
  const item = readObject(value, 'transfer item');
  const kind = readString(item.kind, 'kind');
  if (kind !== 'FLOOR' && kind !== 'ROOM' && kind !== 'CAMERA') {
    throw new Error('invalid transfer kind');
  }
  return {
    kind,
    edgeRef: readString(item.edgeRef, 'edgeRef'),
    canonicalId: readString(item.canonicalId, 'canonicalId'),
    parentCanonicalId:
      item.parentCanonicalId === null
        ? null
        : readString(item.parentCanonicalId, 'parentCanonicalId'),
  };
}
