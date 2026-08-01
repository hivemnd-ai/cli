import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigRepository } from "../src/config.js";
import type {
  ApiClient,
  DeliveryObservationReceipt,
  HivemndConfig,
  SyncReceipt,
  SyncChange,
} from "../src/domain.js";
import { profileKey } from "../src/organizations/registry.js";
import {
  MAXIMUM_CLIENT_SEQUENCE,
  ReceiptOutbox,
} from "../src/sync/receipt-outbox.js";
import { buildDeliveryObservationReceipt } from "../src/sync/receipt.js";
import { runCli, type RuntimeDependencies } from "../src/cli.js";
import { SyncApplier } from "../src/sync/applier.js";
import { SyncPlanner } from "../src/sync/planner.js";
import { createFilesystemAdapters } from "../src/agents/destinations.js";
import {
  api,
  bytes,
  captureOutput,
  hash,
  manifest,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe("durable installation delivery observations", () => {
  it("atomically upgrades legacy destinations once and keeps identity across label and path changes", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const path = join(temp.path, "config.json");
    const firstPath = join(temp.path, "first");
    await writeJson(path, {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        {
          name: "codex-workspace",
          agent: "codex",
          scope: "workspace",
          path: firstPath,
        },
      ],
    });
    const repository = new ConfigRepository(temp.path);

    const upgraded = await repository.load(path);
    expect(upgraded.destinations[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const identity = upgraded.destinations[0]!.id;
    await repository.create(
      path,
      {
        ...upgraded,
        destinations: [
          {
            ...upgraded.destinations[0]!,
            name: "codex-renamed",
            path: join(temp.path, "second"),
          },
        ],
      },
      true,
    );

    expect((await repository.load(path)).destinations[0]).toMatchObject({
      id: identity,
      name: "codex-renamed",
      path: join(temp.path, "second"),
    });
  });

  it("fails closed when another process holds the legacy config upgrade lock", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const path = join(temp.path, "config.json");
    await writeJson(path, {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        {
          name: "codex-user",
          agent: "codex",
          scope: "root",
        },
      ],
    });
    await mkdir(`${path}.hivemnd-upgrade.lock`, { mode: 0o700 });

    await expect(
      new ConfigRepository(temp.path).load(path),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const unchanged = JSON.parse(await readFile(path, "utf8")) as {
      destinations: Array<{ id?: string }>;
    };
    expect(unchanged.destinations[0]).not.toHaveProperty("id");
  });

  it("builds a complete deterministic path-free snapshot with exact conflict subjects", () => {
    const desiredArtifact = {
      ...manifest().artifacts[0]!,
      artifactVersionId: "10000000-0000-4000-8000-000000000002",
      logicalId: "10000000-0000-4000-8000-000000000001",
      content: bytes("# desired\n"),
      sha256: hash("# desired\n"),
      size: bytes("# desired\n").byteLength,
    };
    const desiredConflict: SyncChange = {
      artifact: desiredArtifact,
      agent: "codex",
      destinationName: "selected",
      relativePath: "skills/team/SKILL.md",
      destination: "/secret/path/skills/team/SKILL.md",
      kind: "conflict",
      conflictReason: "unmanaged-existing-file",
    };
    const priorConflict: SyncChange = {
      artifact: desiredArtifact,
      owned: {
        relativePath: "skills/team/SKILL.md",
        logicalId: "20000000-0000-4000-8000-000000000001",
        artifactVersionId: "20000000-0000-4000-8000-000000000002",
        releaseId: "20000000-0000-4000-8000-000000000003",
        sha256: hash("prior"),
      },
      agent: "codex",
      destinationName: "selected",
      relativePath: "skills/team/SKILL.md",
      destination: "/another/secret/path",
      kind: "conflict",
      conflictReason: "artifact-ownership-mismatch",
      observedArtifactVersionId: "20000000-0000-4000-8000-000000000002",
    };
    const config: HivemndConfig = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          name: "selected",
          agent: "codex",
          scope: "directory",
          path: "/private/selected",
        },
        {
          id: "30000000-0000-4000-8000-000000000002",
          name: "other",
          agent: "claude",
          scope: "workspace",
          path: "/private/other",
        },
      ],
    };

    const unmanaged = buildDeliveryObservationReceipt({
      idempotencyKey: "40000000-0000-4000-8000-000000000001",
      clientSequence: 7,
      releaseId: "40000000-0000-4000-8000-000000000002",
      status: "blocked",
      config,
      selectedDestinationNames: ["selected"],
      changes: [desiredConflict],
    });
    const owned = buildDeliveryObservationReceipt({
      ...unmanaged,
      idempotencyKey: "40000000-0000-4000-8000-000000000003",
      clientSequence: 8,
      releaseId: "40000000-0000-4000-8000-000000000002",
      status: "blocked",
      config,
      selectedDestinationNames: ["selected"],
      changes: [priorConflict],
    });

    expect(unmanaged.destinations).toEqual([
      {
        id: config.destinations[0]!.id,
        label: "selected",
        clientKind: "codex",
        installScope: "user",
        selected: true,
        operations: [
          {
            artifactId: desiredArtifact.logicalId,
            artifactVersionId: desiredArtifact.artifactVersionId,
            observedArtifactVersionId: null,
            outcome: "conflict",
            reason: "unmanaged_existing_file",
          },
        ],
      },
      {
        id: config.destinations[1]!.id,
        label: "other",
        clientKind: "claude",
        installScope: "workspace",
        selected: false,
        operations: [],
      },
    ]);
    expect(owned.destinations[0]!.operations[0]).toMatchObject({
      artifactId: priorConflict.owned!.logicalId,
      artifactVersionId: priorConflict.owned!.artifactVersionId,
      observedArtifactVersionId: priorConflict.owned!.artifactVersionId,
      reason: "artifact_ownership_mismatch",
    });
    expect(JSON.stringify(owned)).not.toContain("/private");
    expect(JSON.stringify(owned)).not.toContain("secret/path");
  });

  it("normalizes every finite applied, blocked, failed, removal, and always-context outcome", () => {
    const config: HivemndConfig = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        {
          id: "71000000-0000-4000-8000-000000000001",
          name: "codex-user",
          agent: "codex",
          scope: "root",
        },
      ],
    };
    const kinds = ["create", "update", "adopt", "unchanged"] as const;
    const changes: SyncChange[] = kinds.map((kind, index) => {
      const artifact = receiptArtifact(index + 1);
      return {
        artifact,
        ...(kind === "update"
          ? {
              owned: {
                relativePath: artifact.relativePath,
                logicalId: artifact.logicalId,
                artifactVersionId: sequenceUuid(800 + index),
                sha256: hash("prior"),
                releaseId: sequenceUuid(900 + index),
              },
            }
          : {}),
        agent: "codex",
        destinationName: "codex-user",
        relativePath: artifact.relativePath,
        destination: `/private/${kind}`,
        kind,
      };
    });
    const duplicateDesired = changes[0]!.artifact!;
    changes.push({
      artifact: duplicateDesired,
      owned: {
        relativePath: duplicateDesired.relativePath,
        logicalId: duplicateDesired.logicalId,
        artifactVersionId: sequenceUuid(899),
        sha256: hash("prior duplicate"),
        releaseId: sequenceUuid(999),
      },
      agent: "codex",
      destinationName: "codex-user",
      relativePath: duplicateDesired.relativePath,
      destination: "/private/duplicate-update",
      kind: "update",
    });
    const secondUnchanged = receiptArtifact(10);
    const secondUnchangedChange: SyncChange = {
      artifact: secondUnchanged,
      agent: "codex",
      destinationName: "codex-user",
      relativePath: secondUnchanged.relativePath,
      destination: "/private/second-unchanged",
      kind: "unchanged",
    };
    changes.push(secondUnchangedChange);
    const removedArtifact = receiptArtifact(20);
    changes.push({
      owned: {
        relativePath: removedArtifact.relativePath,
        logicalId: removedArtifact.logicalId,
        artifactVersionId: removedArtifact.artifactVersionId,
        sha256: removedArtifact.sha256,
        releaseId: sequenceUuid(920),
      },
      agent: "codex",
      destinationName: "codex-user",
      relativePath: removedArtifact.relativePath,
      destination: "/private/remove",
      kind: "remove",
    });
    const applied = buildDeliveryObservationReceipt({
      idempotencyKey: sequenceUuid(930),
      clientSequence: 1,
      releaseId: sequenceUuid(931),
      status: "applied",
      config,
      selectedDestinationNames: ["codex-user"],
      changes,
      alwaysContextArtifacts: [receiptArtifact(30, "embedded_document")],
      alwaysContextResult: "applied",
    });
    expect(
      applied.destinations[0]!.operations.map(({ outcome, reason }) => [
        outcome,
        reason,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["applied", "created"],
        ["applied", "updated"],
        ["applied", "adopted"],
        ["unchanged", "already_current"],
        ["removed", "no_longer_desired"],
      ]),
    );

    const conflictReasons = [
      "unmanaged-existing-file",
      "owned-file-missing",
      "owned-content-drift",
      "artifact-ownership-mismatch",
    ] as const;
    const conflicts: SyncChange[] = conflictReasons.map(
      (conflictReason, index) => {
        const desired = receiptArtifact(40 + index);
        const prior = receiptArtifact(60 + index);
        return {
          artifact: desired,
          ...(conflictReason === "unmanaged-existing-file"
            ? {}
            : {
                owned: {
                  relativePath: prior.relativePath,
                  logicalId: prior.logicalId,
                  artifactVersionId: prior.artifactVersionId,
                  sha256: prior.sha256,
                  releaseId: sequenceUuid(940),
                },
              }),
          agent: "codex",
          destinationName: "codex-user",
          relativePath: desired.relativePath,
          destination: `/private/conflict-${index}`,
          kind: "conflict",
          conflictReason,
        };
      },
    );
    const unchangedConflict: SyncChange = {
      ...secondUnchangedChange,
      kind: "conflict",
      conflictReason: "unmanaged-existing-file",
    };
    const blocked = buildDeliveryObservationReceipt({
      idempotencyKey: sequenceUuid(941),
      clientSequence: 2,
      releaseId: sequenceUuid(942),
      status: "blocked",
      config,
      selectedDestinationNames: ["codex-user"],
      changes: [...changes, ...conflicts, unchangedConflict],
    });
    expect(
      blocked.destinations[0]!.operations.map(({ reason }) => reason),
    ).toEqual(
      expect.arrayContaining([
        "already_current",
        "unmanaged_existing_file",
        "artifact_ownership_mismatch",
      ]),
    );
    expect(blocked.destinations[0]!.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "created" }),
        expect.objectContaining({ reason: "no_longer_desired" }),
      ]),
    );

    const failed = buildDeliveryObservationReceipt({
      idempotencyKey: sequenceUuid(943),
      clientSequence: 3,
      releaseId: sequenceUuid(944),
      status: "failed",
      config,
      selectedDestinationNames: ["codex-user"],
      changes: [...changes, ...conflicts],
      alwaysContextArtifacts: [receiptArtifact(50, "embedded_document")],
      alwaysContextResult: "failed",
    });
    expect(failed.destinations[0]!.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "failed",
          reason: "local_apply_failed",
        }),
        expect.objectContaining({
          outcome: "unchanged",
          reason: "already_current",
        }),
      ]),
    );
    const currentContext = buildDeliveryObservationReceipt({
      ...failed,
      idempotencyKey: sequenceUuid(945),
      clientSequence: 4,
      releaseId: sequenceUuid(946),
      status: "applied",
      config,
      selectedDestinationNames: ["codex-user"],
      changes: [],
      alwaysContextArtifacts: [
        receiptArtifact(51, "embedded_document"),
        {
          ...receiptArtifact(52, "embedded_document"),
          deliveryTargets: [{ clientKind: "claude", installScope: "user" }],
        },
      ],
      alwaysContextResult: "unchanged",
    });
    expect(currentContext.destinations[0]!.operations).toHaveLength(1);
    expect(currentContext.destinations[0]!.operations[0]).toMatchObject({
      outcome: "unchanged",
      reason: "already_current",
    });
    const noContextEntries = buildDeliveryObservationReceipt({
      idempotencyKey: sequenceUuid(947),
      clientSequence: 5,
      releaseId: sequenceUuid(948),
      status: "applied",
      config,
      selectedDestinationNames: ["codex-user"],
      changes: [],
      alwaysContextResult: "unchanged",
    });
    expect(noContextEntries.destinations[0]!.operations).toEqual([]);
  });

  it("fails closed instead of fabricating malformed operation subjects or identities", () => {
    const config: HivemndConfig = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [{ name: "codex-user", agent: "codex", scope: "root" }],
    };
    const base = {
      idempotencyKey: sequenceUuid(950),
      clientSequence: 1,
      releaseId: sequenceUuid(951),
      status: "blocked" as const,
      config,
      selectedDestinationNames: ["codex-user"],
    };
    expect(() =>
      buildDeliveryObservationReceipt({ ...base, changes: [] }),
    ).toThrow("Invalid opaque UUID");
    const identified = {
      ...base,
      config: {
        ...config,
        destinations: [{ ...config.destinations[0]!, id: sequenceUuid(952) }],
      },
    };
    expect(() =>
      buildDeliveryObservationReceipt({
        ...identified,
        changes: [
          {
            agent: "codex",
            destinationName: "codex-user",
            relativePath: "x",
            destination: "/private/x",
            kind: "conflict",
          },
        ],
      }),
    ).toThrow("missing its bounded reason");
    expect(() =>
      buildDeliveryObservationReceipt({
        ...identified,
        status: "applied",
        changes: [
          {
            agent: "codex",
            destinationName: "codex-user",
            relativePath: "x",
            destination: "/private/x",
            kind: "remove",
          },
        ],
      }),
    ).toThrow("Missing prior ownership");
    expect(() =>
      buildDeliveryObservationReceipt({
        ...identified,
        status: "applied",
        changes: [
          {
            agent: "codex",
            destinationName: "codex-user",
            relativePath: "x",
            destination: "/private/x",
            kind: "create",
          },
        ],
      }),
    ).toThrow("Missing desired artifact");
  });

  it("stages private FIFO receipts atomically, retries exact bodies, and never stores credentials", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const outbox = new ReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    const first = receipt(11);
    const second = receipt(12);
    await outbox.stage(first);
    await outbox.stage(second);
    const root = join(
      temp.path,
      "organizations",
      profileKey("https://shared.hivemnd.cloud/eigen"),
      "receipt-outbox",
    );
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const firstPath = join(root, `${first.idempotencyKey}.json`);
    expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(firstPath, "utf8")).not.toContain("bearer-secret");
    const delivered: DeliveryObservationReceipt[] = [];
    const client = {
      ...api(),
      receipt: vi.fn(async (token: string, value: SyncReceipt) => {
        expect(token).toBe("bearer-secret");
        if ("clientSequence" in value) delivered.push(value);
      }),
    };

    await expect(
      outbox.deliverPending(client, "bearer-secret"),
    ).resolves.toEqual({
      accepted: 2,
      pending: 0,
    });
    expect(delivered.map(({ clientSequence }) => clientSequence)).toEqual([
      11, 12,
    ]);
    expect(client.receipt).toHaveBeenNthCalledWith(1, "bearer-secret", first);
    expect(client.receipt).toHaveBeenNthCalledWith(2, "bearer-secret", second);
  });

  it("preserves FIFO on response loss and rejects capacity before staging", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const outbox = new ReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      maximumEntries: 2,
    });
    const first = receipt(1);
    const second = receipt(2);
    await outbox.stage(first);
    await outbox.stage(second);
    const client = {
      ...api(),
      receipt: vi.fn(async () => Promise.reject(new Error("response lost"))),
    };

    await expect(
      outbox.deliverPending(client, "current-token"),
    ).resolves.toEqual({
      accepted: 0,
      pending: 2,
      deferredCode: "SYNC_FAILED",
    });
    expect(client.receipt).toHaveBeenCalledTimes(1);
    await expect(outbox.assertCapacity(receipt(3))).rejects.toMatchObject({
      code: "SYNC_FAILED",
    });
    expect(
      (await outbox.pending()).map(({ clientSequence }) => clientSequence),
    ).toEqual([1, 2]);
  });

  it("rejects byte capacity and every malformed bounded aggregate before writing", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const byteBounded = new ReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      maximumBytes: 1,
    });
    await expect(byteBounded.assertCapacity(receipt(1))).rejects.toMatchObject({
      code: "SYNC_FAILED",
    });

    const outbox = new ReceiptOutbox({
      stateDirectory: join(temp.path, "invalid"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    const valid = receiptWithOperation();
    const destination = valid.destinations[0]!;
    const operation = destination.operations[0]!;
    const invalid = [
      { ...valid, unknown: "telemetry" },
      {
        ...valid,
        destinations: [
          {
            ...destination,
            operations: [{ ...operation, reason: "local_apply_failed" }],
          },
        ],
      },
      {
        ...valid,
        destinations: [
          {
            ...destination,
            operations: [
              {
                ...operation,
                observedArtifactVersionId: sequenceUuid(6_001),
              },
            ],
          },
        ],
      },
      {
        ...valid,
        destinations: [
          {
            ...destination,
            operations: [
              {
                ...operation,
                outcome: "removed",
                reason: "no_longer_desired",
              },
            ],
          },
        ],
      },
      { ...valid, destinations: [{ ...destination, selected: false }] },
      {
        ...valid,
        destinations: [{ ...destination, operations: [operation, operation] }],
      },
      { ...valid, destinations: [destination, destination] },
      {
        ...valid,
        status: "failed",
        destinations: [
          {
            ...destination,
            operations: [
              {
                ...operation,
                outcome: "conflict",
                reason: "unmanaged_existing_file",
                observedArtifactVersionId: null,
              },
            ],
          },
        ],
      },
      {
        ...valid,
        destinations: [
          {
            ...destination,
            operations: Array.from({ length: 10_001 }, (_, index) => ({
              ...operation,
              artifactId: sequenceUuid(10_000 + index),
            })),
          },
        ],
      },
    ];
    for (const candidate of invalid) {
      await expect(
        outbox.assertCapacity(candidate as DeliveryObservationReceipt),
      ).rejects.toMatchObject({ code: "SYNC_FAILED" });
    }
    expect(await outbox.pending()).toEqual([]);
  });

  it("fails closed on concurrent sync, corrupt private state, and unsafe outbox paths", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const outbox = new ReceiptOutbox({ stateDirectory: temp.path, apiUrl });
    await outbox.withLock(async () => {
      await expect(
        outbox.withLock(async () => undefined),
      ).rejects.toMatchObject({
        code: "SYNC_FAILED",
      });
    });

    const organizationRoot = join(
      temp.path,
      "organizations",
      profileKey(apiUrl),
    );
    await writeFile(join(organizationRoot, "receipt-sequence.json"), "broken");
    await expect(
      outbox.allocate({
        lastClientSequence: null,
        nextObservationSequence: 1,
        sequenceExhausted: false,
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });

    const corruptRoot = join(temp.path, "corrupt");
    const corrupt = new ReceiptOutbox({ stateDirectory: corruptRoot, apiUrl });
    await mkdir(corrupt.root, { recursive: true });
    const corruptPath = join(corrupt.root, `${sequenceUuid(6_100)}.json`);
    await writeFile(corruptPath, "{");
    await expect(corrupt.pending()).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    await rm(corruptPath);
    await writeFile(
      join(corrupt.root, `${sequenceUuid(6_101)}.json`),
      JSON.stringify(receipt(61)),
    );
    await expect(corrupt.pending()).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });

    const tied = new ReceiptOutbox({
      stateDirectory: join(temp.path, "tied"),
      apiUrl,
    });
    await mkdir(tied.root, { recursive: true });
    const laterId = { ...receipt(90), idempotencyKey: sequenceUuid(6_300) };
    const earlierId = { ...receipt(90), idempotencyKey: sequenceUuid(6_299) };
    await writeFile(
      join(tied.root, `${laterId.idempotencyKey}.json`),
      JSON.stringify(laterId),
    );
    await writeFile(
      join(tied.root, `${earlierId.idempotencyKey}.json`),
      JSON.stringify(earlierId),
    );
    expect(
      (await tied.pending()).map(({ idempotencyKey }) => idempotencyKey),
    ).toEqual([earlierId.idempotencyKey, laterId.idempotencyKey]);

    const notDirectory = new ReceiptOutbox({
      stateDirectory: join(temp.path, "not-directory"),
      apiUrl,
    });
    await mkdir(join(notDirectory.root, ".."), { recursive: true });
    await writeFile(notDirectory.root, "not a directory");
    await expect(notDirectory.pending()).rejects.toMatchObject({
      code: "ENOTDIR",
    });

    const unsafe = new ReceiptOutbox({
      stateDirectory: join(temp.path, "unsafe"),
      apiUrl,
    });
    const target = join(temp.path, "outbox-target");
    await mkdir(join(unsafe.root, ".."), { recursive: true });
    await mkdir(target);
    await symlink(target, unsafe.root, "dir");
    await expect(unsafe.stage(receipt(70))).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });

    const collision = new ReceiptOutbox({
      stateDirectory: join(temp.path, "collision"),
      apiUrl,
    });
    await mkdir(join(collision.root, `${receipt(80).idempotencyKey}.json`), {
      recursive: true,
    });
    await expect(collision.stage(receipt(80))).rejects.toBeDefined();
  });

  it("rejects incoherent bootstrap values and reuse of an allocated sequence", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const outbox = new ReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    const invalid = [
      {
        lastClientSequence: null,
        nextObservationSequence: 2,
        sequenceExhausted: false,
      },
      {
        lastClientSequence: 1,
        nextObservationSequence: null,
        sequenceExhausted: false,
      },
      {
        lastClientSequence: 2,
        nextObservationSequence: 2,
        sequenceExhausted: false,
      },
      {
        lastClientSequence: 0,
        nextObservationSequence: 1,
        sequenceExhausted: false,
      },
      {
        lastClientSequence: MAXIMUM_CLIENT_SEQUENCE,
        nextObservationSequence: null,
        sequenceExhausted: false,
      },
      {
        lastClientSequence: 1,
        nextObservationSequence: 2,
        sequenceExhausted: true,
      },
    ];
    for (const bootstrap of invalid) {
      await expect(outbox.allocate(bootstrap)).rejects.toMatchObject({
        code: "CLIENT_CONFIGURATION_INVALID",
      });
    }
    await outbox.stage(receipt(1));
    await expect(
      outbox.stage({ ...receipt(2), clientSequence: 1 }),
    ).rejects.toThrow("cannot be reused");
  });

  it("removes a receipt if advancing its private sequence state fails", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    let writes = 0;
    const outbox = new ReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      writePrivate: async (path, content) => {
        writes += 1;
        if (writes === 2) throw new Error("sequence state unavailable");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
    });

    await expect(outbox.stage(receipt(1))).rejects.toThrow(
      "sequence state unavailable",
    );
    expect(await outbox.pending()).toEqual([]);
  });

  it("recovers last plus one, fails closed at maximum, and never wraps or reuses", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const outbox = new ReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    expect(
      await outbox.allocate({
        lastClientSequence: 40,
        nextObservationSequence: 41,
        sequenceExhausted: false,
      }),
    ).toBe(41);
    await outbox.stage(receipt(41));
    expect(
      await outbox.allocate({
        lastClientSequence: null,
        nextObservationSequence: 1,
        sequenceExhausted: false,
      }),
    ).toBe(42);
    await outbox.stage(receipt(MAXIMUM_CLIENT_SEQUENCE));
    await expect(
      outbox.allocate({
        lastClientSequence: MAXIMUM_CLIENT_SEQUENCE,
        nextObservationSequence: null,
        sequenceExhausted: true,
      }),
    ).rejects.toMatchObject({ code: "SYNC_FAILED" });
    await expect(
      outbox.allocate({
        lastClientSequence: MAXIMUM_CLIENT_SEQUENCE - 1,
        nextObservationSequence: MAXIMUM_CLIENT_SEQUENCE,
        sequenceExhausted: false,
      }),
    ).rejects.toMatchObject({ code: "SYNC_FAILED" });
  });

  it("rolls filesystem state back when required outbox staging fails", async () => {
    const fixture = await cliFixture();
    const selected = fixture.config.destinations[0]!;
    const managed = join(selected.path!, ".agents/skills/team/SKILL.md");
    vi.spyOn(ReceiptOutbox.prototype, "stage").mockRejectedValueOnce(
      new Error("simulated atomic rename failure"),
    );

    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(1);
    await expect(readFile(managed)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.receiptCall).toHaveBeenCalledWith(
      "current-token",
      expect.objectContaining({ status: "failed", clientSequence: 1 }),
    );
  });

  it("commits and delivers exact v2 observations while advancing local sequence", async () => {
    const fixture = await cliFixture();
    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(0);
    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(0);

    const delivered = vi
      .mocked(fixture.receiptCall)
      .mock.calls.map(([, value]) => value)
      .filter(
        (value): value is DeliveryObservationReceipt =>
          "clientSequence" in value,
      );
    expect(delivered.map(({ clientSequence }) => clientSequence)).toEqual([
      1, 2,
    ]);
    expect(delivered[0]).toMatchObject({
      status: "applied",
      destinations: [
        expect.objectContaining({
          id: fixture.config.destinations[0]!.id,
          label: "codex-workspace",
          selected: true,
          operations: [
            expect.objectContaining({ outcome: "applied", reason: "created" }),
          ],
        }),
      ],
    });
    expect(delivered[1]!.destinations[0]!.operations[0]).toMatchObject({
      outcome: "unchanged",
      reason: "already_current",
    });
    const outbox = new ReceiptOutbox({
      stateDirectory: fixture.stateDirectory,
      apiUrl: fixture.config.apiUrl,
    });
    expect(await outbox.pending()).toEqual([]);
    expect(fixture.dependencies.output.messages).toContain("receipt: accepted");
  });

  it("includes a newly cached always-context version in the selected destination snapshot", async () => {
    const fixture = await cliFixture({ alwaysContext: true });
    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(0);

    const delivered = vi
      .mocked(fixture.receiptCall)
      .mock.calls.map(([, value]) => value)
      .find(
        (value): value is DeliveryObservationReceipt =>
          "clientSequence" in value,
      );
    expect(delivered?.destinations[0]?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "60000000-0000-4000-8000-000000000005",
          outcome: "applied",
          reason: "updated",
        }),
      ]),
    );
  });

  it("preserves a newly committed observation when delivery is offline", async () => {
    const fixture = await cliFixture({ receiptFailure: new Error("offline") });
    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(0);

    const outbox = new ReceiptOutbox({
      stateDirectory: fixture.stateDirectory,
      apiUrl: fixture.config.apiUrl,
    });
    expect(await outbox.pending()).toHaveLength(1);
    expect(fixture.dependencies.output.messages).toContain(
      "receipt: deferred (SYNC_FAILED)",
    );
    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(0);
    expect(fixture.dependencies.output.messages).toContain(
      "receipt retry: deferred (SYNC_FAILED)",
    );
  });

  it("stages and delivers a blocked observation without modifying an unmanaged file", async () => {
    const fixture = await cliFixture();
    const managed = join(
      fixture.config.destinations[0]!.path!,
      ".agents/skills/team/SKILL.md",
    );
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, "# private local skill\n");

    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(1);
    await expect(readFile(managed, "utf8")).resolves.toBe(
      "# private local skill\n",
    );
    expect(fixture.receiptCall).toHaveBeenCalledWith(
      "current-token",
      expect.objectContaining({
        status: "blocked",
        destinations: [
          expect.objectContaining({
            operations: [
              expect.objectContaining({
                outcome: "conflict",
                reason: "unmanaged_existing_file",
              }),
            ],
          }),
        ],
      }),
    );
  });

  it("reports a non-attributable managed-instruction conflict without fabricating an operation", async () => {
    const fixture = await cliFixture();
    const destination = fixture.config.destinations[0]!;
    const ownershipPath = join(
      fixture.stateDirectory,
      "destinations",
      profileKey(fixture.config.apiUrl),
      destination.name,
      "ownership.json",
    );
    await writeJson(ownershipPath, {
      version: 2,
      artifacts: {},
      contextInstruction: {
        blockSha256: hash("legacy managed block"),
        prefix: "",
        createdFile: false,
      },
    });
    const instructionPath = join(destination.path!, "AGENTS.md");
    await mkdir(dirname(instructionPath), { recursive: true });
    await writeFile(
      instructionPath,
      "<!-- BEGIN HIVEMND MANAGED ALWAYS CONTEXT -->\nmalformed",
    );

    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(1);
    const observation = vi
      .mocked(fixture.receiptCall)
      .mock.calls.map(([, value]) => value)
      .find(
        (value): value is DeliveryObservationReceipt =>
          "clientSequence" in value,
      );
    expect(observation).toMatchObject({
      status: "blocked",
      destinations: [expect.objectContaining({ operations: [] })],
    });
    await expect(readFile(instructionPath, "utf8")).resolves.toContain(
      "malformed",
    );
  });

  it("replays pending receipts without invoking planning, apply, or destination adapters", async () => {
    const fixture = await cliFixture();
    const outbox = new ReceiptOutbox({
      stateDirectory: fixture.stateDirectory,
      apiUrl: fixture.config.apiUrl,
    });
    await outbox.stage(receipt(1));
    const plan = vi.spyOn(SyncPlanner.prototype, "plan");
    const apply = vi.spyOn(SyncApplier.prototype, "apply");
    const receiptCall = vi.fn(async () => undefined);
    const offlineManifestApi: ApiClient = {
      ...fixture.api,
      receipt: receiptCall,
      manifest: async () => Promise.reject(new Error("stop after retry")),
    };
    const retryDependencies = {
      ...fixture.dependencies,
      apiClientFactory: () => offlineManifestApi,
    };

    await expect(
      runCli(["sync", "--all", "--apply"], retryDependencies),
    ).resolves.toBe(1);
    expect(receiptCall).toHaveBeenCalledTimes(1);
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(fixture.adapterFactory).not.toHaveBeenCalled();
    expect(await outbox.pending()).toEqual([]);
  });

  it("does not mutate files or the outbox when bootstrap reports sequence exhaustion", async () => {
    const fixture = await cliFixture({ exhausted: true });
    const managed = join(
      fixture.config.destinations[0]!.path!,
      ".agents/skills/team/SKILL.md",
    );

    await expect(
      runCli(["sync", "--all", "--apply"], fixture.dependencies),
    ).resolves.toBe(1);
    await expect(readFile(managed)).rejects.toMatchObject({ code: "ENOENT" });
    const outbox = new ReceiptOutbox({
      stateDirectory: fixture.stateDirectory,
      apiUrl: fixture.config.apiUrl,
    });
    expect(await outbox.pending()).toEqual([]);
  });
});

function receipt(clientSequence: number): DeliveryObservationReceipt {
  const id = sequenceUuid(clientSequence);
  return {
    idempotencyKey: id,
    clientSequence,
    releaseId: "50000000-0000-4000-8000-000000000001",
    status: "applied",
    destinations: [],
  };
}

function receiptWithOperation(): DeliveryObservationReceipt {
  return {
    idempotencyKey: sequenceUuid(6_200),
    clientSequence: 1,
    releaseId: sequenceUuid(6_201),
    status: "applied",
    destinations: [
      {
        id: sequenceUuid(6_202),
        label: "codex-user",
        clientKind: "codex",
        installScope: "user",
        selected: true,
        operations: [
          {
            artifactId: sequenceUuid(6_203),
            artifactVersionId: sequenceUuid(6_204),
            observedArtifactVersionId: sequenceUuid(6_204),
            outcome: "applied",
            reason: "created",
          },
        ],
      },
    ],
  };
}

function sequenceUuid(sequence: number): string {
  const suffix = String(sequence).padStart(12, "0").slice(-12);
  return `50000000-0000-4000-8000-${suffix}`;
}

function receiptArtifact(
  sequence: number,
  kind: "skill" | "embedded_document" = "skill",
) {
  const content = bytes(`# artifact ${sequence}\n`);
  return {
    artifactVersionId: sequenceUuid(1_000 + sequence),
    logicalId: sequenceUuid(2_000 + sequence),
    kind,
    version: 1,
    relativePath:
      kind === "embedded_document"
        ? `context/artifact-${sequence}.md`
        : `skills/artifact-${sequence}/SKILL.md`,
    size: content.byteLength,
    sha256: hash(content),
    contentPath: `/api/v1/artifact-versions/${sequenceUuid(1_000 + sequence)}/content`,
    targets: ["codex"] as const,
    deliveryTargets: [{ clientKind: "codex", installScope: "user" }] as const,
    content,
  };
}

async function cliFixture(
  options: {
    exhausted?: boolean;
    receiptFailure?: Error;
    alwaysContext?: boolean;
  } = {},
) {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const stateDirectory = join(temp.path, ".hivemnd");
  const configPath = join(stateDirectory, "config.json");
  const selectedManifest = manifest();
  const artifact = selectedManifest.artifacts[0]!;
  Object.assign(selectedManifest, {
    release: { id: "60000000-0000-4000-8000-000000000001", sequence: 1 },
    artifacts: [
      {
        ...artifact,
        logicalId: "60000000-0000-4000-8000-000000000002",
        artifactVersionId: "60000000-0000-4000-8000-000000000003",
      },
      ...(options.alwaysContext
        ? [
            {
              ...artifact,
              logicalId: "60000000-0000-4000-8000-000000000005",
              artifactVersionId: "60000000-0000-4000-8000-000000000006",
              kind: "embedded_document" as const,
              relativePath: "context/operating-method.md",
              contentPath:
                "/api/v1/artifact-versions/60000000-0000-4000-8000-000000000006/content",
              targets: ["codex"] as const,
              deliveryTargets: [
                {
                  clientKind: "codex" as const,
                  installScope: "workspace" as const,
                },
              ],
            },
          ]
        : []),
    ],
  });
  const selectedConfig: HivemndConfig = {
    apiUrl: "https://shared.hivemnd.cloud/eigen",
    destinations: [
      {
        id: "60000000-0000-4000-8000-000000000004",
        name: "codex-workspace",
        agent: "codex",
        scope: "workspace",
        path: join(temp.path, "workspace"),
      },
    ],
  };
  await writeJson(configPath, selectedConfig);
  const output = captureOutput();
  const receiptCall = vi.fn(async (_token: string, _receipt: SyncReceipt) => {
    void _token;
    void _receipt;
    if (options.receiptFailure) throw options.receiptFailure;
  });
  const selectedApi: ApiClient = {
    ...api(),
    clientConfiguration: async () => ({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex"],
      installation: {
        clientVersion: "9.8.7-test",
        capabilityKeys: [],
        lastClientSequence: options.exhausted ? MAXIMUM_CLIENT_SEQUENCE : null,
        nextObservationSequence: options.exhausted ? null : 1,
        sequenceExhausted: options.exhausted === true,
      },
    }),
    manifest: async () => selectedManifest,
    download: async () => bytes("# Team skill\n"),
    receipt: receiptCall,
  };
  const adapterFactory = vi.fn(
    (config: HivemndConfig, destinationNames: readonly string[]) =>
      createFilesystemAdapters(
        config,
        destinationNames,
        join(temp.path, "home"),
        stateDirectory,
      ),
  );
  const dependencies: RuntimeDependencies & { output: typeof output } = {
    cwd: temp.path,
    homeDirectory: join(temp.path, "home"),
    environment: { HIVEMND_HOME: stateDirectory },
    output,
    prompt: { interactive: false, input: vi.fn(), confirm: vi.fn() },
    readHookInput: async () => "",
    configRepositoryFactory: (cwd) => new ConfigRepository(cwd),
    tokenStoreFactory: () => ({
      get: async () => ({ value: "current-token", source: "environment" }),
      save: async () => undefined,
    }),
    apiClientFactory: () => selectedApi,
    adapterFactory,
    targetAccess: async () => undefined,
    id: randomUUID,
    clientPlatform: "test-platform",
    clientVersion: "9.8.7-test",
    clientFeatures: ["exact-delivery-targets-v1"],
    updateService: {
      check: async () => ({
        checked: false,
        currentVersion: "9.8.7-test",
        updateAvailable: false,
        command: "npm install --global @hivemnd-ai/cli@latest",
      }),
    },
    scheduleManagerFactory: () => ({
      install: vi.fn(),
      status: vi.fn(),
      remove: vi.fn(),
    }),
  };
  return {
    temp,
    stateDirectory,
    config: selectedConfig,
    api: selectedApi,
    receiptCall,
    dependencies,
    adapterFactory,
  };
}
