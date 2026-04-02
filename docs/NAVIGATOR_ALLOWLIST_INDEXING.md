# Navigator Allowlist Indexing

The daoships-app frontend now posts navigator allowlist data on-chain via the Poster contract when deploying navigators with an address allowlist. The indexer needs to recognize and store this data so that allowlisted users can generate Merkle proofs to onboard.

## Tag

```
daoships.navigator.allowlist
```

## Who Posts

The **deployer's wallet** (the human wallet that deployed the navigator contract). This is NOT the navigator contract itself and NOT the DAO vault. The deployer posts this immediately after deploying the navigator, before any governance proposal is created.

## Trust Level

Use `MEMBER` trust. The deployer is typically a DAO member, but may not be a recognized navigator address in the registry yet (the `setNavigators` governance proposal hasn't been processed at this point — the navigator is deployed but not yet registered with the DAO).

**Important:** Do NOT require `SEMI_TRUSTED`. The `SEMI_TRUSTED` level in `determineTrustLevel()` (poster.ts:39-40) checks `ctx.registry.getDaoByNavigatorAddress(user)`, which looks up whether `msg.sender` is a navigator contract. But for allowlist posts, `msg.sender` is the deployer wallet, not the navigator contract.

**Validation alternative:** Instead of relying solely on trust level, the indexer can verify that the `navigatorAddress` in the content actually exists on-chain as a contract (code size > 0) and that its `allowlistRoot()` matches the `root` in the post. This confirms the post is legitimate without requiring the deployer to be a recognized navigator.

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

## On-Chain Verification (Optional Enhancement)

For additional security, the indexer can verify the posted `root` matches the navigator contract's on-chain `allowlistRoot()` view function:

```typescript
const navigatorContract = new ethers.Contract(navigatorAddress, ['function allowlistRoot() view returns (bytes32)'], provider);
const onChainRoot = await navigatorContract.allowlistRoot();
if (onChainRoot.toLowerCase() !== root.toLowerCase()) {
  logger.warn({ navigatorAddress, postedRoot: root, onChainRoot }, 'Allowlist root mismatch — rejecting post');
  return; // Don't index
}
```

This is optional but recommended — it prevents spam posts with fake allowlist data.
