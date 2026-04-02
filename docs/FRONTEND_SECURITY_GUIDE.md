# Frontend Security Guide

This document defines the security contract between the DAO Ships indexer and the frontend. Every field in every table is classified by trust level. Every rendering decision is mapped to a concrete code pattern.

Read this before writing any component that displays indexer data.

---

## 1. Trust Boundaries

The indexer stores two fundamentally different categories of data:

**Contract-derived data** is extracted from on-chain events emitted by audited smart contracts. The indexer validates addresses and parses event parameters, but the data originates from EVM execution. This data is trustworthy for display -- an attacker cannot forge a `SubmitProposal` event without actually submitting a proposal.

**User-supplied data** arrives through the Poster contract (EIP-3722), which is permissionless. Anyone can call `poster.post(content, tag)`. The indexer applies trust-level filtering and schema validation, but the content itself is arbitrary text chosen by a wallet holder. This data is untrusted and must be escaped or sanitized before rendering.

### Table-by-Table Trust Map

#### ds_daos

| Column | Trust | Source | Rendering |
|--------|-------|--------|-----------|
| `id` | Contract | DAOShip factory event | Plain text (hex address) |
| `created_at` | Contract | Block timestamp | UTC timestamp |
| `tx_hash` | Contract | Transaction receipt | Plain text (hex) |
| `shares_address` | Contract | Factory event | Plain text (hex address) |
| `loot_address` | Contract | Factory event | Plain text (hex address) |
| `avatar` | Contract | Factory event (vault address) | Plain text (hex address) |
| `launcher` | Contract | Factory event | Plain text (hex address) |
| `voting_period`, `grace_period`, `default_expiry_window` | Contract | GovernanceConfigSet event | Numeric |
| `proposal_offering`, `quorum_percent`, `sponsor_threshold`, `min_retention_percent` | Contract | GovernanceConfigSet event | BigInt string (see Section 7) |
| `total_shares`, `total_loot` | Contract | Derived from Transfer events | BigInt string |
| `active_member_count`, `proposal_count` | Contract | Derived counts | Numeric |
| `share_token_name`, `share_token_symbol` | Contract | ERC20 name()/symbol() | Plain text -- escape, but low risk |
| `loot_token_name`, `loot_token_symbol` | Contract | ERC20 name()/symbol() | Plain text -- escape, but low risk |
| `loot_paused`, `shares_paused`, `admin_locked`, `manager_locked`, `governor_locked`, `new_vault` | Contract | On-chain state | Boolean |
| **`name`** | **UNTRUSTED** | Poster content_json (max 100 chars) | **Must escape. Never use in dangerouslySetInnerHTML.** |
| **`description`** | **UNTRUSTED** | Poster content_json (max 1000 chars) | **Sanitize as Markdown or escape as plain text.** |
| **`avatar_img`** | **UNTRUSTED** | Poster content_json URL (max 2048 chars) | **Validate URL scheme before use. See Section 4.** |
| `profile_source` | Indexer | Set to `'launcher'` or `'vault'` by indexer logic | Plain text (enum-like) |

#### ds_members

| Column | Trust | Source | Rendering |
|--------|-------|--------|-----------|
| `id`, `dao_id`, `member_address` | Contract | Transfer/factory events | Plain text (hex) |
| `shares`, `loot`, `voting_power` | Contract | Transfer events | BigInt string |
| `delegating_to` | Contract | DelegateChanged event | Plain text (hex address) or null |
| `votes` | Contract | Derived count from ds_votes | Numeric |
| `created_at`, `updated_at`, `last_activity_at` | Contract | Block timestamps | UTC timestamp |

All ds_members columns are contract-derived. No user-supplied strings.

#### ds_proposals

| Column | Trust | Source | Rendering |
|--------|-------|--------|-----------|
| `id`, `dao_id`, `proposal_id` | Contract | SubmitProposal event | Plain text |
| `submitter`, `sponsor`, `cancelled_by`, `processed_by` | Contract | Event args | Plain text (hex address) |
| `tx_hash`, `sponsor_tx_hash`, `cancelled_tx_hash`, `process_tx_hash` | Contract | Transaction receipts | Plain text (hex) |
| `proposal_data_hash` | Contract | SubmitProposal event | Plain text (hex) |
| `yes_votes`, `no_votes`, `yes_balance`, `no_balance` | Contract | Derived from ds_votes | Numeric / BigInt string |
| `voting_period`, timestamps | Contract | Event args / calculated | Numeric / UTC timestamp |
| `sponsored`, `cancelled`, `processed`, `passed`, `action_failed`, `self_sponsored` | Contract | Event booleans | Boolean |
| **`proposal_data`** | **UNTRUSTED** | Decoded calldata (hex string) | **Display as hex only. Never interpret as HTML.** |
| **`details`** | **UNTRUSTED** | SubmitProposal event string arg | **Escape as plain text. May contain user-written title or IPFS CID.** |
| `proposal_offering`, balance columns | Contract | Event args | BigInt string |

#### ds_votes

All columns are contract-derived. No user-supplied strings.

#### ds_navigators

| Column | Trust | Source | Rendering |
|--------|-------|--------|-----------|
| `id`, `dao_id`, `navigator_address` | Contract | NavigatorSet event | Plain text (hex) |
| `deployer` | Contract | NavigatorDeployed event | Plain text (hex) |
| `permission`, `permission_label` | Contract | NavigatorSet event | Numeric / enum string |
| `is_active`, `paused` | Contract | NavigatorSet event | Boolean |
| `navigator_type` | Contract | NavigatorDeployed event | Plain text or null |
| `tx_hash`, `created_at` | Contract | Event / block timestamp | Plain text / timestamp |
| **`name`** | **Deployer-authored** | NavigatorDeployed event (max 255 chars) or governance Poster update | **Must escape.** Initially set by deployer in constructor, updatable via governance proposal. |
| **`description`** | **Deployer-authored** | NavigatorDeployed event (max 1000 chars) or governance Poster update | **Sanitize as Markdown or escape.** |
#### ds_records

**Every column in ds_records except structural fields is untrusted.** This table stores raw Poster content.

| Column | Trust | Source | Rendering |
|--------|-------|--------|-----------|
| `id`, `dao_id`, `tx_hash`, `block_number` | Contract | Event metadata | Plain text |
| `created_at` | Contract | Block timestamp | UTC timestamp |
| `user_address` | Contract | `msg.sender` from Poster event | Plain text (hex address) |
| `tag` | Indexer | Resolved from keccak256 hash | Plain text (known enum) |
| `trust_level` | Indexer | Computed by `determineTrustLevel()` | Plain text (known enum) |
| `content_type` | Indexer | `'application/json'` or `'text/plain'` | Plain text (known enum) |
| **`content`** | **UNTRUSTED** | Raw post body (max 16KB) | **Never render as HTML. Escape or ignore.** |
| **`content_json`** | **UNTRUSTED** | Validated subset of parsed content | **See Section 5 for per-tag handling.** |

#### ds_ragequits, ds_guild_tokens, ds_delegations, ds_event_transactions, ds_navigator_events

All columns are contract-derived. No user-supplied strings except `ds_navigator_events.metadata` (JSONB from the indexer's event parsing -- treat as semi-trusted but still escape string values when rendering).

---

## 2. XSS Prevention

### Fields That Contain User-Supplied Strings

These are the only fields across all tables that can contain attacker-controlled text:

| Table | Field | Max Length | Content Type |
|-------|-------|-----------|--------------|
| `ds_daos` | `name` | 100 | Short text (DAO name) |
| `ds_daos` | `description` | 1000 | Long text / potential Markdown |
| `ds_daos` | `avatar_img` | 2048 | URL |
| `ds_proposals` | `details` | 16KB | Short text / IPFS CID |
| `ds_proposals` | `proposal_data` | Unbounded | Hex-encoded calldata |
| `ds_navigators` | `name` | 100 | Short text |
| `ds_navigators` | `description` | 1000 | Long text / potential Markdown |
| `ds_records` | `content` | 16KB | Raw post body |
| `ds_records` | `content_json` | JSONB | Validated per-tag object |

### React JSX Auto-Escaping

React's JSX expressions auto-escape string values. This is your primary defense:

```tsx
// SAFE: React escapes the string automatically
<h1>{dao.name}</h1>
<p>{dao.description}</p>
<span>{record.content}</span>

// DANGEROUS: Never do this with user-supplied data
<div dangerouslySetInnerHTML={{ __html: dao.description }} />  // XSS
<div dangerouslySetInnerHTML={{ __html: record.content }} />   // XSS
```

**Rule: Never use `dangerouslySetInnerHTML` with any field from `ds_daos`, `ds_records`, `ds_navigators`, or `ds_proposals`.**

### Markdown Rendering

If you render `description`, `body`, `bio`, or `reason` fields as Markdown, you must sanitize the HTML output. Raw Markdown-to-HTML conversion produces unsanitized HTML that can contain `<script>`, `<img onerror>`, and other XSS vectors.

Recommended stack:

```tsx
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure DOMPurify: strip everything except safe formatting tags
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u', 's', 'del',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'hr', 'sup', 'sub',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|ipfs):\/\/)/i,  // Only http, https, ipfs
  ALLOW_DATA_ATTR: false,
};

function renderMarkdown(untrustedMarkdown: string): string {
  const rawHtml = marked.parse(untrustedMarkdown, { async: false });
  return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
}

// Usage in React component
function Description({ text }: { text: string }) {
  const safeHtml = renderMarkdown(text);
  return <div dangerouslySetInnerHTML={{ __html: safeHtml }} />;
}
```

**Critical: `ALLOWED_URI_REGEXP` must block `javascript:` URIs.** The config above achieves this by only allowing `https?` and `ipfs` schemes.

Do not use `react-markdown` without explicit sanitization. Versions before v9 had various bypass issues. If you use it, configure `rehype-sanitize` with an explicit allow-list:

```tsx
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a || []), ['href', /^https?:\/\//]],
  },
};

<ReactMarkdown rehypePlugins={[[rehypeSanitize, schema]]}>
  {dao.description}
</ReactMarkdown>
```

### Field-by-Field Rendering Guide

| Field | Render As | Method |
|-------|-----------|--------|
| `dao.name` | Plain text | `{dao.name}` (JSX auto-escape) |
| `dao.description` | Markdown | `renderMarkdown()` with DOMPurify |
| `dao.avatar_img` | Image src | Validate URL first (Section 4) |
| `proposal.details` | Plain text | `{proposal.details}` (JSX auto-escape) |
| `proposal.proposal_data` | Hex display | `{proposal.proposal_data}` or truncated |
| `navigator.name` | Plain text | `{navigator.name}` (JSX auto-escape) |
| `navigator.description` | Markdown | `renderMarkdown()` with DOMPurify |
| `record.content_json.body` | Markdown | `renderMarkdown()` with DOMPurify |
| `record.content_json.reason` | Plain text or Markdown | `renderMarkdown()` with DOMPurify |
| `record.content_json.title` | Plain text | `{title}` (JSX auto-escape) |
| `record.content_json.name` | Plain text | `{name}` (JSX auto-escape) |
| `record.content_json.bio` | Markdown | `renderMarkdown()` with DOMPurify |
| `record.content_json.links` | URL list | Validate each URL (Section 4) |
| `record.content_json.tags` | Tag chips | `{tag}` (JSX auto-escape per item) |

---

## 3. Trust Level Display

### The Five Trust Levels

The indexer computes a trust level for every `ds_records` row. This reflects who posted the content and their relationship to the DAO:

| Level | `trust_level` Value | Who | Meaning |
|-------|-------------------|-----|---------|
| Verified | `VERIFIED` | DAO's avatar (vault) address, or the DAOShip contract itself | Posted via governance proposal. This is the DAO speaking officially. |
| Verified Initial | `VERIFIED_INITIAL` | The deployer wallet, only for `dao.profile.initial` tag | Set by the person who launched the DAO, before governance exists. |
| Semi-Trusted | `SEMI_TRUSTED` | A navigator contract registered to the DAO | Posted by a DAO-approved smart contract. Trustworthy but not governance-voted. |
| Member | `MEMBER` | A wallet holding shares > 0 in the DAO | Posted by a verified shareholder. The identity is real, but the content is their opinion. |
| Untrusted | `UNTRUSTED` | N/A | The indexer rejects UNTRUSTED posts entirely. You will never see this value in the database. |

### Badge Display Logic

```tsx
type TrustLevel = 'VERIFIED' | 'VERIFIED_INITIAL' | 'SEMI_TRUSTED' | 'MEMBER';

function TrustBadge({ level }: { level: TrustLevel }) {
  switch (level) {
    case 'VERIFIED':
      return <Badge variant="verified">Verified (Governance)</Badge>;
    case 'VERIFIED_INITIAL':
      return <Badge variant="initial">Set by Deployer</Badge>;
    case 'SEMI_TRUSTED':
      return <Badge variant="semi">Navigator</Badge>;
    case 'MEMBER':
      return <Badge variant="member">Member</Badge>;
    default:
      return null; // Unknown trust level -- render nothing, not a default badge
  }
}
```

### DAO Profile Source

The `ds_daos.profile_source` column tells you how the DAO's `name`, `description`, and `avatar_img` were set:

| `profile_source` | Meaning | Display Guidance |
|-------------------|---------|------------------|
| `null` | No profile has been set yet | Show "Unnamed DAO" or the contract address |
| `'launcher'` | Set by the deployer at launch (`dao.profile.initial`) | Show the profile but indicate it is deployer-set, not governance-approved |
| `'vault'` | Set via governance proposal (`dao.profile`) | Show with full verification badge |

```tsx
function DaoName({ dao }: { dao: DaoRow }) {
  if (!dao.name) {
    return <span className="text-muted">{truncateAddress(dao.id)}</span>;
  }

  return (
    <span>
      {dao.name}
      {dao.profile_source === 'vault' && <VerifiedIcon title="Set via governance" />}
      {dao.profile_source === 'launcher' && <InfoIcon title="Set by deployer (not yet governance-approved)" />}
    </span>
  );
}
```

### Differentiating Content by Trust Level

When displaying records (announcements, vote reasons, member profiles, etc.), visually distinguish trust levels:

```tsx
function RecordCard({ record }: { record: RecordRow }) {
  const trustStyle = {
    VERIFIED: 'border-green-500 bg-green-50',
    VERIFIED_INITIAL: 'border-blue-500 bg-blue-50',
    SEMI_TRUSTED: 'border-yellow-500 bg-yellow-50',
    MEMBER: 'border-gray-300 bg-white',
  }[record.trust_level ?? 'MEMBER'];

  return (
    <div className={`border-l-4 p-4 ${trustStyle}`}>
      <TrustBadge level={record.trust_level as TrustLevel} />
      {/* render content_json fields per tag -- see Section 5 */}
    </div>
  );
}
```

**Do not allow MEMBER-trust content to appear identical to VERIFIED content.** A member can post a `daoships.member.profile` or `daoships.proposal.vote.reason` that could be confused with official DAO content if badges are missing. The trust level is the only thing separating a DAO's official voice from an individual member's opinion.

---

## 4. URL Handling

### Valid URL Schemes

The indexer's `urlStr()` validator only allows three schemes:

- `http://`
- `https://`
- `ipfs://`

Any URL that does not start with one of these is stripped to `undefined` during validation. However, the frontend must still validate, because:

1. The `ds_daos.avatar_img` field is set by `extractDaoMetadataUpdates()`, which has its own `isValidUrl()` check but the raw `content` column in `ds_records` is unvalidated.
2. Defense in depth -- never rely solely on backend validation.

### URL Validation Helper

```typescript
const SAFE_URL_PATTERN = /^(https?:\/\/|ipfs:\/\/)/i;

function isSafeUrl(url: string | null | undefined): url is string {
  if (!url || typeof url !== 'string') return false;
  return SAFE_URL_PATTERN.test(url.trim());
}

// For href attributes specifically -- stricter, blocks http:// for external links
function isSafeHref(url: string | null | undefined): url is string {
  if (!isSafeUrl(url)) return false;
  // Block javascript: that might sneak past via URL encoding or mixed case
  const decoded = decodeURIComponent(url).toLowerCase().trim();
  return !decoded.startsWith('javascript:') && !decoded.startsWith('data:');
}
```

### IPFS URL Rendering

IPFS URLs (`ipfs://Qm...` or `ipfs://bafy...`) cannot be loaded directly by browsers. Convert them to an HTTPS gateway URL:

```typescript
const IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
// Alternative: 'https://cloudflare-ipfs.com/ipfs/'
// Alternative: 'https://dweb.link/ipfs/'

function resolveUrl(url: string): string {
  if (url.startsWith('ipfs://')) {
    const cid = url.slice(7); // Remove 'ipfs://'
    return `${IPFS_GATEWAY}${cid}`;
  }
  return url;
}
```

### Image Loading

Never set `src` on an `<img>` tag with an unvalidated URL:

```tsx
function DaoAvatar({ url }: { url: string | null | undefined }) {
  if (!isSafeUrl(url)) {
    return <FallbackAvatar />;
  }

  const resolved = resolveUrl(url);

  return (
    <img
      src={resolved}
      alt=""  // Decorative -- alt text from name field, not URL
      loading="lazy"
      referrerPolicy="no-referrer"  // Do not leak page URL to image host
      crossOrigin="anonymous"       // Prevent credential leakage
      onError={(e) => {
        // Replace broken images with fallback, do not retry
        (e.target as HTMLImageElement).src = '/fallback-avatar.png';
        (e.target as HTMLImageElement).onerror = null; // prevent loop
      }}
    />
  );
}
```

### Link Rendering

```tsx
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!isSafeHref(href)) {
    // Render as plain text if URL is suspicious
    return <span>{children}</span>;
  }

  return (
    <a
      href={resolveUrl(href)}
      target="_blank"
      rel="noopener noreferrer nofollow"  // All three are required
    >
      {children}
    </a>
  );
}
```

### Content Security Policy

Configure your CSP to restrict image and connect sources:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' https://gateway.pinata.cloud https://cloudflare-ipfs.com https://dweb.link https: data:;
  connect-src 'self' https://*.supabase.co wss://*.supabase.co;
  font-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
```

Note: `img-src https:` is intentionally broad because DAO avatar URLs can point to any HTTPS host. If you want tighter control, proxy all external images through your own server.

---

## 5. content_json Safety

### Defense in Depth

The indexer validates `content_json` with per-tag schema validators that:

- Strip unrecognized fields (only known keys survive)
- Enforce max lengths on all strings (via `str()` helper)
- Validate URL schemes on all URL fields (via `urlStr()` helper)
- Block prototype pollution keys (`__proto__`, `constructor`, `prototype`)
- Strip null bytes and C0/C1 control characters
- Require `schemaVersion` on all posts (rejected if missing)
- Enforce 16KB hard content size limit (rejected above 16,384 bytes)
- Cap arrays at fixed maximums (tags: 20 items, labels: 50, links: 20 keys)

**Despite all of this, the frontend must treat `content_json` as untrusted.** Reasons:

1. Validation bugs in the indexer could allow unexpected values through.
2. Schema changes in the indexer may add fields before the frontend is updated.
3. Existing records from before stricter validation was deployed remain in the database.

### Expected Shapes by Tag

```typescript
// daoships.dao.profile.initial (all fields required except optional ones)
interface DaoProfileInitialJson {
  schemaVersion: string;   // required
  daoAddress: string;      // required, max 42
  name: string;            // required, max 100
  description: string;     // required, max 1000
  avatar?: string;         // URL, max 2048
  banner?: string;         // URL, max 2048
  links?: Record<string, string>;  // max 20 keys, values are URLs
  tags?: string[];         // max 20 items, max 50 chars each
  chainId?: number;
}

// daoships.dao.profile (partial updates -- only daoAddress required)
interface DaoProfileJson {
  schemaVersion: string;   // required
  daoAddress: string;      // required, max 42
  name?: string;           // max 100
  description?: string;    // max 1000
  avatar?: string;         // URL, max 2048
  banner?: string;         // URL, max 2048
  links?: Record<string, string>;  // max 20 keys, values are URLs
  tags?: string[];         // max 20 items, max 50 chars each
  chainId?: number;
}

// daoships.dao.announcement
interface DaoAnnouncementJson {
  schemaVersion: string;   // required
  daoAddress: string;      // required, max 42
  title: string;           // required, max 200
  body?: string;           // max 4096
  severity?: 'info' | 'warning' | 'critical';
}

// daoships.member.profile
interface MemberProfileJson {
  schemaVersion: string;   // required
  daoAddress?: string;     // optional (global if omitted), max 42
  name: string;            // required, max 100
  bio?: string;            // max 1000
  avatar?: string;         // URL, max 2048
}

// daoships.proposal.vote.reason
interface VoteReasonJson {
  schemaVersion: string;   // required
  daoAddress: string;      // required, max 42
  proposalId?: number;
  vote?: boolean;
  reason: string;          // required, max 2000
}

// daoships.navigator.allowlist (MEMBER trust)
interface NavigatorAllowlistJson {
  schemaVersion: string;   // required
  daoAddress: string;      // required, hex address
  navigatorAddress: string; // required, hex address
  root: string;            // required, bytes32 Merkle root
  addresses: string[];     // required, non-empty array of hex addresses
  treeDump: object;        // required, StandardMerkleTree.dump() output
}
```

### Handling null content_json

When `content_json` is `null`, it means one of:

1. The raw `content` was not valid JSON.
2. The parsed JSON failed tag-specific validation (missing required fields, wrong types).
3. The validator threw an exception.

Always handle this case:

```tsx
function RecordContent({ record }: { record: RecordRow }) {
  if (!record.content_json) {
    // Validation failed. Show a minimal fallback.
    return (
      <div className="text-muted italic">
        Content could not be parsed.
        <details>
          <summary>Raw content</summary>
          {/* JSX auto-escapes this */}
          <pre className="text-xs overflow-auto max-h-40">{record.content}</pre>
        </details>
      </div>
    );
  }

  // Proceed with type-safe rendering based on record.tag
  switch (record.tag) {
    case 'daoships.dao.announcement':
      return <AnnouncementCard json={record.content_json as DaoAnnouncementJson} />;
    // ... other tags
  }
}
```

### Handling Missing Optional Fields

Every field except those marked "required" in the schemas above may be `undefined`. Always use optional chaining and nullish coalescing:

```tsx
function AnnouncementCard({ json }: { json: DaoAnnouncementJson }) {
  return (
    <div>
      <h3>{json.title ?? 'Untitled Announcement'}</h3>
      {json.body ? (
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(json.body) }} />
      ) : (
        <p className="text-muted">No content.</p>
      )}
      {json.severity && json.severity !== 'info' && (
        <Badge variant={json.severity}>{json.severity}</Badge>
      )}
    </div>
  );
}
```

---

## 6. Realtime Security

### Same Trust Rules Apply

Supabase Realtime delivers full row data via WebSocket when rows are inserted or updated. The data is identical to what you would get from a REST query. All trust classifications, XSS prevention, and URL validation rules from Sections 1-5 apply to realtime payloads with no exceptions.

```typescript
supabase
  .channel('dao-records')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'testnet', table: 'ds_records' },
    (payload) => {
      const record = payload.new as RecordRow;

      // WRONG: trusting realtime data without validation
      // document.innerHTML = record.content;

      // CORRECT: apply the same rendering pipeline
      // Pass through your existing component/rendering logic
      addRecord(record); // Let React components handle escaping
    },
  )
  .subscribe();
```

### Do Not Assume Ordering

Realtime events can arrive out of order due to network latency, Supabase internal buffering, or chain reorgs. Rules:

1. **Do not assume a realtime INSERT is newer than your current state.** Compare `block_number` or `created_at` before replacing displayed data.
2. **Handle DELETE events from reorg recovery.** The indexer's `ds_delete_events_after_block` function deletes rows during reorgs. Your realtime subscription will receive DELETE events. Remove these from your local state.
3. **Realtime does not guarantee delivery.** If the WebSocket disconnects and reconnects, you may miss events. Re-fetch from REST after reconnection.

```typescript
function handleRealtimeRecord(existingRecords: RecordRow[], newRecord: RecordRow): RecordRow[] {
  // Check if we already have this record
  const existingIndex = existingRecords.findIndex((r) => r.id === newRecord.id);

  if (existingIndex >= 0) {
    const existing = existingRecords[existingIndex];
    // Only replace if the new record has a higher (or equal) block number
    if ((newRecord.block_number ?? 0) >= (existing.block_number ?? 0)) {
      const updated = [...existingRecords];
      updated[existingIndex] = newRecord;
      return updated;
    }
    return existingRecords; // Keep existing, ignore stale update
  }

  return [...existingRecords, newRecord];
}
```

### Optimistic vs. Confirmed State

The indexer writes data only after blocks are confirmed (past the reorg walk-back window). There is no "pending" state in the database. If your frontend shows optimistic/pending transaction state (e.g., "Your vote is being submitted..."), that state lives entirely in the frontend and must be clearly distinguished from confirmed on-chain data:

```tsx
function VoteStatus({ isPending, confirmedVote }: Props) {
  if (isPending) {
    return <Badge variant="outline">Pending confirmation...</Badge>;
  }
  if (confirmedVote) {
    return <Badge variant="solid">{confirmedVote.approved ? 'Yes' : 'No'}</Badge>;
  }
  return null;
}
```

Never merge optimistic state into the same data structures as confirmed state. Keep them separate.

---

## 7. Common Pitfalls

### Prototype Pollution from JSONB Objects

The `content_json` column is PostgreSQL JSONB, deserialized to plain JavaScript objects by the Supabase client. Although the indexer blocks `__proto__`, `constructor`, and `prototype` keys, always iterate safely:

```typescript
// SAFE: Object.keys() returns own enumerable properties only
Object.keys(json).forEach((key) => {
  console.log(key, json[key]);
});

// SAFE: Object.entries() also returns own properties only
for (const [key, value] of Object.entries(json)) {
  console.log(key, value);
}

// DANGEROUS: for...in iterates inherited properties
for (const key in json) {  // DO NOT USE
  console.log(key, json[key]);
}

// DANGEROUS: Direct property access without hasOwnProperty check
if (json[userInput]) { ... }  // Prototype chain lookup

// SAFE: Use Object.hasOwn() (ES2022) or hasOwnProperty
if (Object.hasOwn(json, key)) {
  // ...
}
```

Additionally, never spread JSONB objects into state without explicit field extraction:

```typescript
// DANGEROUS: Spreading unknown JSONB into component state
const [state, setState] = useState({ ...record.content_json });

// SAFE: Extract only the fields you expect
const { title, body, severity } = record.content_json as DaoAnnouncementJson;
const [state, setState] = useState({ title, body, severity });
```

### BigInt Handling

Supabase returns PostgreSQL `NUMERIC(78,0)` columns as **strings**, not numbers. This is correct behavior -- these values can exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1). The affected columns are:

- `ds_daos`: `total_shares`, `total_loot`, `proposal_offering`, `quorum_percent`, `sponsor_threshold`, `min_retention_percent`
- `ds_members`: `shares`, `loot`, `voting_power`
- `ds_proposals`: `yes_balance`, `no_balance`, `max_total_shares_and_loot_at_vote`, `max_total_shares_at_sponsor`, `proposal_offering`
- `ds_votes`: `balance`
- `ds_ragequits`: `shares_burned`, `loot_burned`
- `ds_navigator_events`: `shares_minted`, `loot_minted`, `amount`

```typescript
// WRONG: parseFloat loses precision on large numbers
const shares = parseFloat(member.shares);  // 1234567890123456789 becomes 1234567890123456800

// WRONG: parseInt loses precision too
const shares = parseInt(member.shares);

// CORRECT: Use BigInt for arithmetic
const shares = BigInt(member.shares);
const loot = BigInt(member.loot);
const totalPower = shares + loot;

// CORRECT: For display, format the string directly
function formatTokenAmount(value: string, decimals: number = 18): string {
  const bi = BigInt(value);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = bi / divisor;
  const remainder = bi % divisor;
  const fractionStr = remainder.toString().padStart(decimals, '0').slice(0, 4);
  return `${whole.toLocaleString()}.${fractionStr}`;
}

// CORRECT: For comparisons
function hasVotingPower(member: MemberRow): boolean {
  return BigInt(member.shares) > 0n || BigInt(member.loot) > 0n;
}

// CAUTION: BigInt cannot be serialized to JSON by default
JSON.stringify({ shares: BigInt(member.shares) }); // Throws TypeError
// Convert to string first if you need to serialize
JSON.stringify({ shares: member.shares }); // Already a string from Supabase
```

Always wrap `BigInt()` calls in try-catch when the input comes from `content_json` or other user-influenced fields:

```typescript
function safeBigInt(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  return 0n; // Safe default
}
```

### Address Comparison

All addresses in the database are stored lowercase (the indexer calls `validateAndNormalizeAddress` which lowercases). But addresses from wallet providers (MetaMask, etc.) may arrive in mixed-case EIP-55 checksum format. Always normalize before comparing:

```typescript
// WRONG: Case-sensitive comparison
if (connectedAddress === dao.avatar) { ... }  // May fail

// CORRECT: Normalize both sides
if (connectedAddress.toLowerCase() === dao.avatar) { ... }

// CORRECT: Utility function
function addressEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// When using addresses as React keys or Map keys, always lowercase
const memberMap = new Map<string, MemberRow>();
members.forEach((m) => memberMap.set(m.member_address.toLowerCase(), m));
```

### Timestamp Handling

All timestamps in the database are `TIMESTAMPTZ` (PostgreSQL timestamp with time zone). Supabase returns them as ISO 8601 strings in UTC:

```typescript
// The string from Supabase looks like: "2026-03-25T14:30:00.000Z"

// CORRECT: Parse as Date (JavaScript Date constructor handles ISO 8601)
const date = new Date(record.created_at);

// CORRECT: Display in user's local timezone
const formatted = date.toLocaleDateString(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// WRONG: Treating the timestamp as local time
// The 'Z' suffix means UTC. If you strip it, you get the wrong time.

// For relative times ("5 minutes ago"), use a library like date-fns or dayjs
import { formatDistanceToNow } from 'date-fns';
const relative = formatDistanceToNow(new Date(record.created_at), { addSuffix: true });
```

### Voting Period and Grace Period

`voting_period` and `grace_period` are stored as seconds (BIGINT). `voting_starts`, `voting_ends`, and `grace_ends` are full timestamps. Use the timestamps for display, not manual arithmetic:

```typescript
// CORRECT: Use the pre-calculated timestamps
const votingEnds = new Date(proposal.voting_ends);
const isVotingActive = new Date() < votingEnds;

// AVOID: Manual calculation (the indexer already did this)
// const votingEnds = new Date(proposal.voting_starts + proposal.voting_period * 1000);
```
