# DAO Ships Indexer

Real-time blockchain event indexer for the [DAO Ships](https://github.com/your-org/daoships-contracts) governance protocol on Quai Network. Processes on-chain events from DAOShip contracts and stores structured data in Supabase PostgreSQL for frontend consumption.

## Architecture

```
Quai Network (RPC)      DAO Ships Indexer         Poster (EIP-3722)
  DAOShipLauncher       Block Processor           NewPost events
  DAOShip clones   -->  Event Handlers    <--
  Token clones          Contract Registry
  Navigators            Database Writer
                              |
                        Supabase (PostgreSQL)
```

**Key design principles:**
- **Event-driven** — All state derived from on-chain events, zero RPC calls in handlers
- **Idempotent** — All counter operations derive from source tables (safe to retry)
- **Topic-based filtering** — O(1) RPC calls per poll cycle regardless of DAO count
- **Event ownership** — Transfer events own member balances; MintShares/BurnShares own DAO totals

## Quick Start

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your Supabase credentials and contract addresses

# Create database schema
# Paste supabase/migrations/schema.sql in Supabase SQL Editor, then:
#   SELECT create_ds_schema('dev');

# Build and run
npm run build
npm run start
```

## Configuration

All configuration via environment variables. See [.env.example](.env.example) for all options.

**Required:**
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — Service role key (bypasses RLS)

**Contract addresses:**
- `DAOSHIP_AND_VAULT_LAUNCHER` — Factory for DAO + vault deployment
- `DAOSHIP_LAUNCHER` — Factory for DAO-only deployment
- `POSTER` — EIP-3722 Poster contract for metadata

Navigator addresses are discovered dynamically via `NavigatorSet` events — no static config needed.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the indexer (production) |
| `npm run dev` | Run with hot-reload (development) |
| `npm run backfill` | Standalone backfill from `BACKFILL_FROM` to `BACKFILL_TO` |
| `npm run test:run` | Run unit tests |
| `npm run test:e2e` | Run on-chain E2E tests (requires running indexer + testnet) |
| `npm run typecheck` | TypeScript type checking |

## Database Schema

The indexer uses a multi-environment schema pattern with `ds_` table prefixes:

| Table | Purpose |
|-------|---------|
| `ds_daos` | DAO records, governance params, token totals |
| `ds_members` | Member balances, delegation, vote counts |
| `ds_proposals` | Proposal lifecycle (submit, sponsor, vote, process, cancel) |
| `ds_votes` | Individual vote records |
| `ds_navigators` | Registered navigators with permissions and type |
| `ds_navigator_events` | Onboard events from navigators |
| `ds_ragequits` | Member exit records with per-token amounts |
| `ds_records` | Poster metadata (profiles, rationale, announcements) |
| `ds_guild_tokens` | Registered ragequit tokens |
| `ds_delegations` | Delegation change history |
| `ds_event_transactions` | Transaction dedup tracking |
| `ds_processed_logs` | Log-level dedup for retry idempotency |
| `ds_indexer_state` | Last processed block + sync state |

Schema management:
```sql
SELECT create_ds_schema('dev');       -- Create
SELECT drop_ds_schema('dev');         -- Drop (full teardown)
```

## Events Indexed (24)

| Category | Events |
|----------|--------|
| Launcher | `LaunchDAOShip`, `LaunchDAOShipAndVault` |
| Setup | `SetupComplete` |
| Governance | `SubmitProposal`, `SponsorProposal`, `SubmitVote`, `ProcessProposal`, `CancelProposal` |
| Gov Management | `NavigatorSet`, `SetGuildTokens`, `GovernanceConfigSet`, `LockAdmin/Manager/Governor` |
| Token Ops | `MintShares`, `MintLoot`, `BurnShares`, `BurnLoot`, `ConvertSharesToLoot` |
| Admin | `AdminConfigSet` |
| Token (ERC20) | `Transfer`, `DelegateChanged`, `DelegateVotesChanged`, `Paused`, `Unpaused` |
| Navigator | `Onboard` (OnboarderNavigator + ERC20TributeNavigator) |
| Exit | `Ragequit` |
| Poster | `NewPost` (14 recognized tags) |

## Poster Trust Model

The indexer enforces a 5-level trust hierarchy for Poster (EIP-3722) metadata:

| Trust Level | Who | Can Do |
|-------------|-----|--------|
| VERIFIED | DAO vault (avatar) or DAOShip contract | Set/update DAO profiles, announcements, treasury labels |
| VERIFIED_INITIAL | Deployer wallet (launcher) | Set initial DAO profile (superseded by vault) |
| SEMI_TRUSTED | Navigator contracts | Post navigator metadata, announcements, treasury reports |
| MEMBER | Wallets with shares > 0 | Member profiles, vote reasons, proposal rationale |
| UNTRUSTED | Anyone | Rejected — no UNTRUSTED tags accepted |

Unrecognized tags are silently dropped to prevent database bloat.

## Health Endpoint

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Full health status (200/503) |
| `GET /ready` | Readiness probe for Kubernetes |
| `GET /live` | Liveness probe (always 200) |

Rate-limited per IP. CORS restricted to configured origins. Security headers applied.

## Testing

**Unit tests** (182 tests):
```bash
npm run test:run
```

**On-chain E2E tests** (24 events, 16 phases):
```bash
# Terminal 1: Start the indexer
npm run start

# Terminal 2: Run E2E tests
npm run test:e2e
```

E2E tests deploy contracts on Quai Orchard testnet, trigger all 24 event types, and verify indexed data in Supabase.

## Security

See [AUDIT_REPORT_2026-03-23.md](AUDIT_REPORT_2026-03-23.md) for the full audit report.

**0 Critical, 0 High, 0 Medium open findings.** 22 positive security observations documented.
