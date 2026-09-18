-- ============================================================================
-- Migration 0006 — Phase 10: user management integrity
--
--   user_roles gets a unique index on (user_id, role_id): the account model is
--   one role per user (role change = delete + re-grant inside one transaction),
--   so duplicate grants are a bug, not state. The in-migration check first
--   fails loudly if pre-existing duplicates exist (none are expected; roles
--   are only ever granted by bootstrap/create/role-change flows).
--
--   Rollback: DROP INDEX user_roles_user_role_key;
-- ============================================================================

DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT user_id, role_id
    FROM user_roles
    GROUP BY user_id, role_id
    HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'user_roles contains % duplicate (user_id, role_id) grant(s) — resolve before migrating', dup_count;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_key
  ON user_roles (user_id, role_id);
