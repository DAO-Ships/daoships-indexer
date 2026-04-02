# Navigator Allowlist Indexing

The daoships-app frontend now posts navigator allowlist data on-chain via the Poster contract when deploying navigators with an address allowlist. The indexer needs to recognize and store this data so that allowlisted users can generate Merkle proofs to onboard.

## Tag

```
daoships.navigator.allowlist
```

## Who Posts

The **deployer's wallet** (the human wallet that deployed the navigator contract). This is NOT the navigator contract itself and NOT the DAO vault. The deployer posts this immediately after deploying the navigator, before any governance proposal is created.

## Trust Level

**When DAO exists**: Use `MEMBER` trust (normal path). The deployer is typically a DAO member.

**When DAO does not exist (pre-launch)**: Use `ON_CHAIN_PROVISIONAL` trust via on-chain verification (`getCode` + `daoShip()` + `allowlistRoot()`). See "On-Chain Verification" section below.

**Important:** Do NOT require `SEMI_TRUSTED`. The deployer wallet is the `msg.sender`, not the navigator contract. If the DAO exists but the poster isn't a member, the post is dropped — no fallback to on-chain verification.

## Content Schema

```json
{
  "schemaVersion": "1.0",
  "daoAddress": "0x00...",
  "navigatorAddress": "0x00...",
  "root": "0xabcdef...",
  "addresses": ["0x00abc...", "0x00def...", ...],
  "treeDump": { ... }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | string | Yes | Always `"1.0"` |
| `daoAddress` | string | Yes | The DAO's DAOShip contract address (lowercase) |
| `navigatorAddress` | string | Yes | The navigator contract address this allowlist belongs to (lowercase) |
| `root` | string | Yes | The Merkle root (bytes32 hex). Must match the navigator's on-chain `allowlistRoot()` |
| `addresses` | string[] | Yes | The full list of allowlisted addresses (checksummed) |
| `treeDump` | object | Yes | The output of `StandardMerkleTree.dump()` from `@openzeppelin/merkle-tree`. Contains the full tree structure needed to reconstruct proofs client-side |

## Storage

Store in the existing `ds_records` table, same as all other Poster content:

- `tag`: `'daoships.navigator.allowlist'`
- `dao_id`: from `content.daoAddress`
- `user_address`: `msg.sender` (the deployer wallet)
- `content_json`: the full validated JSON content
- `created_at`: block timestamp

## Validator Function

Add to `TAG_VALIDATORS` in `poster.ts`:

```typescript
function validateNavigatorAllowlist(p: Record<string, unknown>): Record<string, unknown> | null {
  const daoAddress = str(p.daoAddress, 42);
  const navigatorAddress = str(p.navigatorAddress, 42);
  const root = str(p.root, 66);
  if (!daoAddress || !navigatorAddress || !root) return null;

  // Validate addresses are hex format
  if (!/^0x[0-9a-fA-F]{40}$/.test(daoAddress)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(navigatorAddress)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) return null;

  // Validate addresses array
  const addresses = p.addresses;
  if (!Array.isArray(addresses)) return null;
  const validAddresses = addresses.filter(
    (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
  );
  if (validAddresses.length === 0) return null;

  // treeDump is opaque — store as-is for client-side tree reconstruction
  if (!p.treeDump || typeof p.treeDump !== 'object') return null;

  return clean({
    daoAddress,
    navigatorAddress,
    root,
    addresses: validAddresses,
    treeDump: p.treeDump,
    schemaVersion: str(p.schemaVersion, 10),
  });
}
```

## Registration

### 1. Add tag definition (poster.ts ~line 65)

```typescript
const TAG_DEFINITIONS: TagDefinition[] = [
  // ... existing tags ...
  { tag: 'daoships.navigator.allowlist', minTrust: 'MEMBER', updatesDao: false },
];
```

### 2. Add validator (poster.ts ~line 78)

```typescript
const TAG_VALIDATORS: Record<string, ContentValidator> = {
  // ... existing validators ...
  'daoships.navigator.allowlist': validateNavigatorAllowlist,
};
```

### 3. Add processing case (poster.ts ~line 408, inside the tag switch)

No special processing needed — the allowlist data is stored in `ds_records.content_json` and queried by the frontend via:

```sql
SELECT * FROM ds_records
WHERE dao_id = $1
  AND tag = 'daoships.navigator.allowlist'
ORDER BY created_at DESC
LIMIT 10
```

The frontend then filters client-side by `content_json->>'navigatorAddress'`.

If you want to optimize, add a case that logs the event:

```typescript
case 'daoships.navigator.allowlist': {
  const navAddr = (validatedJson.navigatorAddress as string)?.toLowerCase();
  const addrCount = Array.isArray(validatedJson.addresses) ? validatedJson.addresses.length : 0;
  logger.info({ daoId, navigatorAddress: navAddr, addressCount: addrCount }, 'Navigator allowlist indexed');
  break;
}
```

## Deduplication

Key: `msg.sender` + `tag` + `daoAddress` + `navigatorAddress`

Semantics: **last-write-wins** — a newer post replaces the older one. In practice, allowlists are set once at deployment (the navigator's `allowlistRoot` is immutable), so there should only ever be one post per navigator.

## Frontend Query Path

The frontend queries this data via:

1. `RecordIndexerService.getNavigatorAllowlist(daoId, navigatorAddress)` — fetches from `ds_records` filtered by tag and navigator address in `content_json`
2. `useNavigatorAllowlist` hook — loads the `treeDump`, verifies the root matches the on-chain `allowlistRoot()`, then generates proofs via `StandardMerkleTree.load(treeDump)`

## Size Considerations

The `treeDump` field contains the full Merkle tree structure. For a 100-address allowlist, this is approximately 8-10KB of JSON. The Poster contract's practical limit is ~16KB per post (enforced client-side in `PosterService`), so allowlists of up to ~150 addresses fit in a single post.

The `ds_records.content_json` column (JSONB) can store this without issues. No special size handling is needed.

## On-Chain Verification (Mandatory for Pre-DAO Posts)

When the DAO does not yet exist in the indexer (allowlist posted before DAO launch), the indexer verifies on-chain instead of using the normal DAO+trust path. Three checks are performed:

1. **Contract existence**: `getCode(navigatorAddress)` — must have deployed code
2. **DAO binding**: `daoShip()` — returned address must match posted `daoAddress` (prevents cross-DAO spoofing)
3. **Root match**: `allowlistRoot()` — must match posted `root`

If all three pass, the record is stored with `dao_id = NULL` and `trust_level = 'ON_CHAIN_PROVISIONAL'`. When the DAO eventually launches, `dao_id` is backfilled automatically (via `ds_reparent_orphaned_records`).

When the DAO already exists, the normal trust path (MEMBER) is used. If trust fails, the post is dropped — **no fallback to on-chain verification** when the DAO exists.

## Orphan Record Lifecycle

Records stored with `dao_id = NULL` (pre-DAO) follow this lifecycle:

1. **Posted**: Stored with `dao_id = NULL`, `trust_level = 'ON_CHAIN_PROVISIONAL'`
2. **DAO launches**: `dao_id` backfilled to match the DAO (in launcher handler)
3. **Pruning**: Unclaimed orphans (DAO never launched) deleted after configurable retention period (default 90 days, `ORPHAN_RETENTION_DAYS` env var). Pruning runs daily in the indexer polling loop.
