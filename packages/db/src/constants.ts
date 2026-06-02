// The single owner. A fixed id keeps "the user" stable across the codebase without a
// seed migration; it's upserted (ON CONFLICT DO NOTHING) wherever a conversation is
// created. Multi-user is out of scope (CONCEPT).
export const OWNER_USER_ID = '00000000-0000-0000-0000-000000000001'
