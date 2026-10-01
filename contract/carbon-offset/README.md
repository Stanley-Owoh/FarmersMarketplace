# Carbon Offset Contract

Stores verifiable carbon offset records on-chain so farmers can display a carbon
neutrality certificate for a delivered order.

## Build & Deploy

```bash
cd contract/carbon-offset
cargo build --target wasm32-unknown-unknown --release
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/carbon_offset.wasm --network testnet
```

## Initialize

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- initialize \
  --admin <PLATFORM_PUBLIC_KEY>
```

## Environment Variables

Add to backend/.env:
```
SOROBAN_CARBON_OFFSET_CONTRACT_ID=<deployed_contract_id>
```

## Usage

After delivery is confirmed, the backend first calls `authorize_offset(order_id,
kg_co2, verifier)` signed by the farmer/verifier, then calls
`record_offset(order_id, kg_co2, verifier)` signed by the platform admin. The
record call requires that exact verifier approval and rejects zero kilograms.
The returned `offset_paid` field remains false because this contract does not
verify or process an offset payment.

`get_offset` is public and returns `None` when no active record exists; it backs
`GET /api/orders/:id/carbon` without relying on a host error for the normal
not-found case. An admin can correct a record with `amend_offset` (which also
requires verifier authorization), or call `void_offset` before authorizing and
recording a replacement. Admin instance storage and persistent offset records
have their TTL refreshed, and admin-transfer/upgrade operations emit events.
