-- ============================================================================
-- Migration 0001 — policies, views, functions, seeds (hand-authored)
-- Complements generated 0000_pnk_init.sql. Reviewed by design.
--
-- Sections:
--   1. CHECK constraints (controlled vocabularies, lifecycle coherence)
--   2. Scheduler counting index
--   3. updated_at trigger
--   4. Assignment history trigger + append-only guards
--   5. Views: v_assignment_counts, profiles
--   6. RLS policies (defense-in-depth; app connects as table owner today)
--   7. Seeds: roles
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. CHECK constraints
-- ----------------------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT users_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE'));

ALTER TABLE "teachers" ADD CONSTRAINT teachers_language_check
  CHECK (language IN ('FILIPINO', 'ENGLISH'));
ALTER TABLE "teachers" ADD CONSTRAINT teachers_status_check
  CHECK (status IN ('ACTIVE', 'INACTIVE'));
ALTER TABLE "teachers" ADD CONSTRAINT teachers_inactive_coherence_check
  CHECK ((status = 'ACTIVE') OR (status = 'INACTIVE' AND date_inactive IS NOT NULL));

ALTER TABLE "dako" ADD CONSTRAINT dako_language_check
  CHECK (language IN ('FILIPINO', 'ENGLISH'));
ALTER TABLE "dako" ADD CONSTRAINT dako_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED'));
ALTER TABLE "dako" ADD CONSTRAINT dako_disabled_coherence_check
  CHECK ((status = 'ACTIVE') OR (status = 'DISABLED' AND date_disabled IS NOT NULL));
ALTER TABLE "dako" ADD CONSTRAINT dako_worship_day_check
  CHECK (worship_day IN ('MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'));
ALTER TABLE "dako" ADD CONSTRAINT dako_worship_time_check
  CHECK (worship_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE "weeks" ADD CONSTRAINT weeks_year_check CHECK (year BETWEEN 1900 AND 2999);
ALTER TABLE "weeks" ADD CONSTRAINT weeks_iso_week_check
  CHECK (iso_week_number BETWEEN 1 AND 53);
ALTER TABLE "weeks" ADD CONSTRAINT weeks_dates_check CHECK (end_date >= start_date);
ALTER TABLE "weeks" ADD CONSTRAINT weeks_status_check
  CHECK (status IN ('DRAFT', 'FINALIZED', 'PUBLISHED'));

ALTER TABLE "teacher_availability" ADD CONSTRAINT teacher_availability_status_check
  CHECK (availability_status IN ('AVAILABLE', 'ABSENT', 'INACTIVE'));

ALTER TABLE "assignments" ADD CONSTRAINT assignments_type_check
  CHECK (assignment_type IN ('SUGO', 'RESERBA', 'RESERBA_II'));
ALTER TABLE "assignments" ADD CONSTRAINT assignments_source_check
  CHECK (assignment_source IN ('AUTO', 'MANUAL', 'OVERRIDE'));
ALTER TABLE "assignments" ADD CONSTRAINT assignments_status_check
  CHECK (status IN ('ASSIGNED', 'ABSENT', 'INACTIVE'));
ALTER TABLE "assignments" ADD CONSTRAINT assignments_override_reason_check
  CHECK (is_override = false OR override_reason IS NOT NULL);

-- ----------------------------------------------------------------------------
-- 2. Scheduler counting index (source-agnostic; powers v_assignment_counts)
-- ----------------------------------------------------------------------------
CREATE INDEX assignments_counting_idx
  ON assignments (teacher_id, dako_id, assignment_type, status);

-- ----------------------------------------------------------------------------
-- 3. updated_at trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_teachers_updated_at BEFORE UPDATE ON teachers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_dako_updated_at BEFORE UPDATE ON dako
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_weeks_updated_at BEFORE UPDATE ON weeks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_teacher_availability_updated_at BEFORE UPDATE ON teacher_availability
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_assignments_updated_at
  BEFORE INSERT OR UPDATE OF status, assignment_type, assignment_source, is_override, override_reason
  ON assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Assignment history trigger + append-only guards
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_assignment_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO assignment_history
      (assignment_id, old_teacher_id, new_teacher_id, old_assignment_type,
       new_assignment_type, old_status, new_status, changed_by, change_reason)
    VALUES
      (NEW.id, NULL, NEW.teacher_id, NULL, NEW.assignment_type,
       NULL, NEW.status, NEW.assigned_by, 'CREATED');
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
      OR NEW.assignment_type IS DISTINCT FROM OLD.assignment_type
      OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO assignment_history
      (assignment_id, old_teacher_id, new_teacher_id, old_assignment_type,
       new_assignment_type, old_status, new_status, changed_by, change_reason)
    VALUES
      (NEW.id, OLD.teacher_id, NEW.teacher_id, OLD.assignment_type,
       NEW.assignment_type, OLD.status, NEW.status, NEW.assigned_by, 'UPDATED');
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assignment_history AFTER INSERT OR UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION fn_assignment_history();

-- assignment_history is append-only: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION fn_forbid_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'assignment_history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ah_no_update BEFORE UPDATE ON assignment_history
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_update();
CREATE TRIGGER trg_ah_no_delete BEFORE DELETE ON assignment_history
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_update();

-- audit_logs is append-only as well.
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_update();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_forbid_update();

-- ----------------------------------------------------------------------------
-- 5. Views
-- ----------------------------------------------------------------------------
-- Source-agnostic scheduler counting model: per teacher×dako×type.
-- Excludes non-ASSIGNED rows (absences/inactive) from counts.
CREATE VIEW v_assignment_counts AS
SELECT
  a.teacher_id,
  a.dako_id,
  a.assignment_type,
  count(*)::int AS total,
  count(*) FILTER (WHERE w.year = date_part('year', now())::int)::int AS year_total,
  max(a.assigned_at) AS last_assigned_at
FROM assignments a
JOIN weeks w ON w.id = a.week_id
WHERE a.status = 'ASSIGNED'
GROUP BY a.teacher_id, a.dako_id, a.assignment_type;

-- Credential-free user projection for UI listing.
CREATE VIEW profiles AS
SELECT
  u.id,
  u.email,
  u.full_name,
  u.status,
  u.must_change_password AS mustChangePassword,
  u.last_login_at AS lastLoginAt,
  u.created_at AS createdAt,
  coalesce(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
FROM users u
LEFT JOIN user_roles ur ON ur.user_id = u.id
LEFT JOIN roles r ON r.id = ur.role_id
GROUP BY u.id;

-- ----------------------------------------------------------------------------
-- 6. RLS (defense-in-depth) — enable on sensitive tables. The app currently
-- connects as the table owner, which bypasses RLS (superuser/owner bypass),
-- so these become active the moment access goes through the scoped roles
-- defined in docker/init/01-roles.sql.
-- ----------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_self_read ON users FOR SELECT
  USING (id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = current_setting('app.current_user_id', true)::uuid);

-- App sets app.current_role per request from server-resolved user_roles.
CREATE POLICY audit_read_admin ON audit_logs FOR SELECT
  USING (current_setting('app.current_role', true) = 'pnk_admin');
CREATE POLICY audit_no_write ON audit_logs FOR INSERT WITH CHECK (false);
CREATE POLICY audit_no_update ON audit_logs FOR UPDATE USING (false);
CREATE POLICY audit_no_delete ON audit_logs FOR DELETE USING (false);

CREATE POLICY notif_self_all ON notifications FOR ALL
  USING (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

-- ----------------------------------------------------------------------------
-- 7. Seeds — roles only (no fake teachers/dako/users)
-- ----------------------------------------------------------------------------
INSERT INTO roles (code, name, description) VALUES
  ('ADMIN', 'Administrator', 'Full system access incl. user management, finalize/unlock, audit logs, settings'),
  ('SCHEDULER', 'Scheduler/Encoder', 'Teachers, dako, availability, assignments, suguan generation, reports'),
  ('VIEWER', 'Viewer', 'Read-only access to schedules, teachers, dako, history, reports')
ON CONFLICT (code) DO NOTHING;

