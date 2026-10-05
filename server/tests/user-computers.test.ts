import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { userComputers } from "../src/db/schema/computer";
import {
  ComputerRowExistsError,
  createUserComputerStore,
  resetSingleFlight,
  singleFlight,
} from "../src/computer/user-computers";
import { users } from "../src/db/schema/core";

/**
 * The invariant is "one user, one computer", and it has to survive two things at once: a person
 * asking twice, and a replica other than the one that answered. The first is the in-process guard;
 * the second is the unique index, and it is the one that is actually true.
 */
const database = createDatabase(process.env.TEST_DATABASE_URL!);
const store = createUserComputerStore(database);

async function makeUser(): Promise<string> {
  const id = `computer-test-${crypto.randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@remii.test`, emailVerified: true })
    .returning();
  return id;
}

beforeEach(() => {
  resetSingleFlight();
});

describe("a user's computer row", () => {
  test("a user has none until one is created", async () => {
    const userId = await makeUser();
    expect(await store.get(userId)).toBeNull();
  });

  test("creating one records it, and it can be read back", async () => {
    const userId = await makeUser();
    const created = await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    expect(created.userId).toBe(userId);
    expect(created.status).toBe("PROVISIONING");
    expect(created.sandboxId).toBeNull();

    const read = await store.get(userId);
    expect(read?.id).toBe(created.id);
  });

  test("a second create for the same user is REFUSED, not silently accepted", async () => {
    // The whole reason the column is unique. A handler that checked first would let two
    // simultaneous requests both provision, and one of the two sandboxes would be unreachable
    // forever because every later lookup resolves to the row the first insert won.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    await expect(
      store.create({ id: crypto.randomUUID(), userId, provider: "e2b" }),
    ).rejects.toBeInstanceOf(ComputerRowExistsError);
  });

  test("the sandbox id is stored, not derived", async () => {
    // Derived names cannot be reconciled: nothing holds the id, so a renamed user addresses a
    // machine that no longer matches and there is no way to ask the provider what we believe we own.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    const patched = await store.patch(userId, {
      sandboxId: "sandbox-abc",
      status: "RUNNING",
    });
    expect(patched?.sandboxId).toBe("sandbox-abc");
    expect(patched?.status).toBe("RUNNING");
  });

  test("desired status is tracked apart from actual status", async () => {
    // A stop is not instant. One column cannot say "the person asked for stopped" and "the machine
    // is still stopping" at the same time, and a deployment that cannot answer that keeps billing
    // for a machine nobody wants.
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    const patched = await store.patch(userId, {
      desiredStatus: "STOPPED",
      status: "STOPPED",
    });
    expect(patched?.desiredStatus).toBe("STOPPED");
    expect(patched?.status).toBe("STOPPED");
  });

  test("removing the row leaves the user with none again", async () => {
    const userId = await makeUser();
    await store.create({
      id: crypto.randomUUID(),
      userId,
      provider: "e2b",
    });
    expect(await store.remove(userId)).toBe(true);
    expect(await store.get(userId)).toBeNull();
  });
});

describe("singleFlight", () => {
  test("two concurrent callers share one run, not two", async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      await Bun.sleep(20);
      return "sandbox-1";
    };
    const [a, b] = await Promise.all([
      singleFlight("user-1", work),
      singleFlight("user-1", work),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe("sandbox-1");
    expect(b).toBe("sandbox-1");
  });

  test("a failure is shared, and the key is released so the next caller retries", async () => {
    // Not releasing would wedge this user for the life of the process: every later request would
    // inherit the first one's rejection and provision nothing, ever.
    let runs = 0;
    const failing = async () => {
      runs += 1;
      throw new Error("provider refused");
    };
    await expect(singleFlight("user-2", failing)).rejects.toThrow(
      "provider refused",
    );
    await expect(singleFlight("user-2", failing)).rejects.toThrow(
      "provider refused",
    );
    expect(runs).toBe(2);
  });

  test("different users do not block each other", async () => {
    const order: string[] = [];
    const slow = (name: string) => async () => {
      order.push(`${name}:start`);
      await Bun.sleep(20);
      order.push(`${name}:end`);
      return name;
    };
    await Promise.all([
      singleFlight("a", slow("a")),
      singleFlight("b", slow("b")),
    ]);
    // Interleaved, which is only true if neither waited on the other's entry.
    expect(order).toEqual(["a:start", "b:start", "a:end", "b:end"]);
  });
});

describe("the unique index itself", () => {
  test("the database refuses two computers for one user even without the store", async () => {
    // The store's check is a courtesy. This is the guarantee, and it holds across replicas because
    // it is not in any one process.
    const userId = await makeUser();
    await database
      .insert(userComputers)
      .values({ id: crypto.randomUUID(), userId });
    // Executed, not merely built: a drizzle insert is a thenable builder, and asserting on one
    // would test that it has a `then` rather than that the insert fails.
    await expect(
      database
        .insert(userComputers)
        .values({ id: crypto.randomUUID(), userId })
        .execute(),
    ).rejects.toThrow();
  });

  test("deleting a user takes their computer with them", async () => {
    const userId = await makeUser();
    await database
      .insert(userComputers)
      .values({ id: crypto.randomUUID(), userId });
    await database.delete(users).where(eq(users.id, userId));
    const left = await database
      .select()
      .from(userComputers)
      .where(eq(userComputers.userId, userId));
    expect(left).toHaveLength(0);
  });
});
