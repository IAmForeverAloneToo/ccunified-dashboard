import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorker, type TestWorker } from "./harness";

describe("0004_access: departments and roles", () => {
  let w: TestWorker;
  beforeAll(async () => {
    w = await startWorker({ migrateUntil: "0003_models.sql" });
  });
  afterAll(() => w.dispose());

  test("keeps users, their sessions and recovery codes, and who decided pairings", async () => {
    const admin = await w.createUser({ role: "admin", username: "boss" });
    const viewer = await w.createUser({ role: "viewer", username: "watcher" });
    await w.sql(
      "INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?1, 'h1', NULL), (?1, 'h2', 5)",
      admin.id,
    );
    await w.sql(
      `UPDATE users SET totp_enabled = 1, totp_secret = 'secret', totp_last_step = 7,
              last_login_at = 9, disabled_at = NULL WHERE id = ?1`,
      admin.id,
    );
    await w.sql(
      `INSERT INTO pairing_requests (id, device_code_hash, user_code, machine_name, os, arch,
         agent_version, sync_interval_minutes, created_at, expires_at, status, decided_by, decided_at)
       VALUES ('p1', 'd1', 'AAAA-BBBB', 'pc', 'linux', 'amd64', '0.3.0', 30, 1, 2, 'approved', ?1, 3)`,
      admin.id,
    );
    const machine = await w.createMachine({ name: "kept" });
    const before = {
      users: await w.sql("SELECT * FROM users ORDER BY username"),
      sessions: await w.sql("SELECT * FROM sessions ORDER BY id_hash"),
      codes: await w.sql("SELECT * FROM recovery_codes ORDER BY code_hash"),
    };
    expect(before.sessions).toHaveLength(2);

    await w.migrate("0004_access.sql");

    expect(await w.sql("SELECT * FROM users ORDER BY username")).toEqual(before.users);
    expect(await w.sql("SELECT * FROM sessions ORDER BY id_hash")).toEqual(before.sessions);
    expect(await w.sql("SELECT * FROM recovery_codes ORDER BY code_hash")).toEqual(before.codes);
    expect(await w.sql("SELECT decided_by FROM pairing_requests WHERE id = 'p1'")).toEqual([
      { decided_by: admin.id },
    ]);
    // Machines start with no department and no owner.
    expect(
      await w.sql("SELECT department_id, owner_id FROM machines WHERE id = ?1", machine.id),
    ).toEqual([{ department_id: null, owner_id: null }]);
    // The old roles still work, and the sessions still log in.
    expect((await w.fetch("/api/me", { cookie: admin.cookie })).status).toBe(200);
    const me = (await (await w.fetch("/api/me", { cookie: viewer.cookie })).json()) as {
      role: string;
    };
    expect(me.role).toBe("viewer");
  });

  test("users may now have no dashboard-wide role, and keys still hold", async () => {
    await w.sql(
      "INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES ('u-none', 'plain', 'x', NULL, 1, 1)",
    );
    await expect(
      w.sql(
        "INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES ('u-bad', 'bad', 'x', 'owner', 1, 1)",
      ),
    ).rejects.toThrow();
    // Deleting a user still removes their sessions.
    const gone = await w.createUser({ role: "viewer", username: "leaving" });
    await w.sql("DELETE FROM users WHERE id = ?1", gone.id);
    expect(await w.sql("SELECT 1 FROM sessions WHERE user_id = ?1", gone.id)).toEqual([]);
  });
});
