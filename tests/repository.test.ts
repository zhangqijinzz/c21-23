import { beforeEach, describe, expect, it } from "vitest";
import {
  ProjectRepository,
  type ProjectStorage,
} from "../src/shared/repositories/projectRepository";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
  type WorkspaceMeta,
} from "../src/shared/domain/types";

const FALLBACK_KEY = "latency-lab.workspace.v1";

class MemoryStorage implements ProjectStorage {
  meta: unknown = undefined;
  projects = new Map<string, unknown>();
  legacy: unknown = undefined;
  failWrite = false;
  writes: { upsert: string[]; removeIds: string[] }[] = [];

  async load(): Promise<{
    meta: unknown;
    projects: unknown[];
    legacy: unknown;
  }> {
    return {
      meta: this.meta === undefined ? undefined : structuredClone(this.meta),
      projects: [...this.projects.values()].map((value) =>
        structuredClone(value),
      ),
      legacy:
        this.legacy === undefined ? undefined : structuredClone(this.legacy),
    };
  }

  async save(
    meta: WorkspaceMeta,
    upsert: LatencyProject[],
    removeIds: string[],
  ): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.meta = structuredClone(meta);
    for (const project of upsert)
      this.projects.set(project.id, structuredClone(project));
    for (const id of removeIds) this.projects.delete(id);
    // 与真实实现一致：每次保存都会清除已迁移的整份旧数据
    this.legacy = undefined;
    this.writes.push({
      upsert: upsert.map((project) => project.id),
      removeIds: [...removeIds],
    });
  }
}

function makeProject(id: string, title = id): LatencyProject {
  return {
    ...structuredClone(EXAMPLE_PROJECT),
    id,
    title,
  };
}

function makeDocument(
  projects: LatencyProject[],
  activeProjectId = projects[0]?.id ?? "",
): WorkspaceDocument {
  return { version: 1, activeProjectId, projects };
}

function readFallback(): { savedAt: number; document: WorkspaceDocument } {
  const raw = localStorage.getItem(FALLBACK_KEY);
  expect(raw).toBeTruthy();
  return JSON.parse(raw as string) as {
    savedAt: number;
    document: WorkspaceDocument;
  };
}

describe("project repository per-project saving", () => {
  beforeEach(() => localStorage.clear());

  it("writes only the changed project and always refreshes the whole recovery copy", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const alpha = makeProject("project-a", "项目 A");
    const beta = makeProject("project-b", "项目 B");
    const first = makeDocument([alpha, beta], alpha.id);

    await repository.save(first);
    expect(storage.writes[0]?.upsert.sort()).toEqual([alpha.id, beta.id]);

    const editedBeta = {
      ...beta,
      title: "项目 B 改",
      updatedAt: beta.updatedAt + 1,
    };
    const second = makeDocument([alpha, editedBeta], alpha.id);
    await repository.save(second, first);

    expect(storage.writes[1]?.upsert).toEqual([beta.id]);
    expect(storage.writes[1]?.removeIds).toEqual([]);
    expect((storage.projects.get(beta.id) as LatencyProject).title).toBe(
      "项目 B 改",
    );
    expect((storage.projects.get(alpha.id) as LatencyProject).title).toBe(
      "项目 A",
    );
    // 本地恢复副本始终保持整份工作区结构
    const fallback = readFallback();
    expect(fallback.document.projects.map((p) => p.id)).toEqual([
      alpha.id,
      beta.id,
    ]);
    expect(fallback.document.projects[1]?.title).toBe("项目 B 改");
    expect(fallback.savedAt).toBeGreaterThan(0);
  });

  it("persists project order and active project in meta without rewriting projects", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const alpha = makeProject("project-a");
    const beta = makeProject("project-b");
    const first = makeDocument([alpha, beta], alpha.id);
    await repository.save(first);

    const switched = makeDocument([alpha, beta], beta.id);
    await repository.save(switched, first);
    expect(storage.writes[1]?.upsert).toEqual([]);
    expect((storage.meta as WorkspaceMeta).activeProjectId).toBe(beta.id);
    expect((storage.meta as WorkspaceMeta).projectIds).toEqual([
      alpha.id,
      beta.id,
    ]);
  });

  it("deletes removed projects from the per-project store", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const alpha = makeProject("project-a");
    const beta = makeProject("project-b");
    const first = makeDocument([alpha, beta], alpha.id);
    await repository.save(first);

    const second = makeDocument([alpha], alpha.id);
    await repository.save(second, first);
    expect(storage.writes[1]?.removeIds).toEqual([beta.id]);
    expect(storage.projects.has(beta.id)).toBe(false);

    const loaded = await repository.load();
    expect(loaded.document.projects.map((p) => p.id)).toEqual([alpha.id]);
  });
});

describe("project repository migration and recovery", () => {
  beforeEach(() => localStorage.clear());

  it("migrates a legacy whole-workspace document on first open without losing content", async () => {
    const storage = new MemoryStorage();
    const alpha = makeProject("project-a", "旧项目 A");
    const beta = makeProject("project-b", "旧项目 B");
    storage.legacy = makeDocument([alpha, beta], beta.id);

    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(false);
    expect(loaded.document.projects.map((p) => p.title)).toEqual([
      "旧项目 A",
      "旧项目 B",
    ]);
    expect(loaded.document.activeProjectId).toBe(beta.id);

    // 迁移后：按项目记录已写入，元信息已建立，整份旧数据已清除
    expect(storage.projects.size).toBe(2);
    expect((storage.meta as WorkspaceMeta).version).toBe(2);
    expect((storage.meta as WorkspaceMeta).projectIds).toEqual([
      alpha.id,
      beta.id,
    ]);
    expect(storage.legacy).toBeUndefined();
    // 恢复副本也同步为整体结构
    expect(readFallback().document.projects).toHaveLength(2);
  });

  it("reads a legacy-format recovery copy (plain document) from localStorage", async () => {
    const storage = new MemoryStorage();
    const alpha = makeProject("project-a", "旧格式副本");
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify(makeDocument([alpha], alpha.id)),
    );

    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.title).toBe("旧格式副本");
    // 载入后已同步为按项目存储
    expect(storage.projects.has(alpha.id)).toBe(true);
  });

  it("prefers the recovery copy when it is newer than the IndexedDB layer", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const stale = makeProject("project-a", "旧标题");
    await repository.save(makeDocument([stale], stale.id));

    const newer = makeProject("project-a", "新标题");
    const newerDoc = makeDocument([newer, makeProject("project-b")], newer.id);
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify({
        savedAt: Date.now() + 60 * 60 * 1000,
        document: newerDoc,
      }),
    );

    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects.map((p) => p.id)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(loaded.document.projects[0]?.title).toBe("新标题");
    // 用胜出的一份修复 IndexedDB 层
    expect((storage.projects.get("project-a") as LatencyProject).title).toBe(
      "新标题",
    );
    expect(storage.projects.has("project-b")).toBe(true);
  });

  it("prefers IndexedDB when its save is newer than the recovery copy", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const current = makeProject("project-a", "当前标题");
    await repository.save(makeDocument([current], current.id));

    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify({
        savedAt: 1,
        document: makeDocument(
          [makeProject("project-x", "过期副本")],
          "project-x",
        ),
      }),
    );

    const loaded = await repository.load();
    expect(loaded.recovered).toBe(false);
    expect(loaded.document.projects.map((p) => p.id)).toEqual(["project-a"]);
    expect(loaded.document.projects[0]?.title).toBe("当前标题");
  });

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.meta = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    const good = makeProject("project-a");
    storage.projects.set(good.id, {
      ...good,
      nodes: [
        { ...good.nodes[0], dependencyIds: ["missing"] },
        { damaged: true },
      ],
    });
    storage.projects.set("project-broken", { id: 9, title: null });
    storage.meta = {
      version: 2,
      activeProjectId: good.id,
      projectIds: [good.id, "project-broken"],
      savedAt: 1,
    };

    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a whole local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(storage);
    const document = makeDocument(
      [structuredClone(EXAMPLE_PROJECT)],
      EXAMPLE_PROJECT.id,
    );
    await expect(repository.save(document)).rejects.toThrow(
      "IndexedDB quota failure",
    );
    // 恢复副本仍是完整工作区，可整体恢复
    const fallback = readFallback();
    expect(fallback.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(fallback.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );

    storage.failWrite = false;
    const loaded = await repository.load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });

  it("falls back to a full sync on the next save after an IndexedDB failure", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const alpha = makeProject("project-a");
    const beta = makeProject("project-b");
    const first = makeDocument([alpha, beta], alpha.id);
    await repository.save(first);

    storage.failWrite = true;
    const editedAlpha = { ...alpha, title: "失败时修改" };
    const second = makeDocument([editedAlpha, beta], alpha.id);
    await expect(repository.save(second, first)).rejects.toThrow();

    storage.failWrite = false;
    // 即使这次只有一个项目变化，失败后也会全量补齐
    const editedBeta = { ...beta, title: "恢复后修改" };
    const third = makeDocument([editedAlpha, editedBeta], alpha.id);
    await repository.save(third, second);
    expect(storage.writes.at(-1)?.upsert.sort()).toEqual([alpha.id, beta.id]);
    expect((storage.projects.get(alpha.id) as LatencyProject).title).toBe(
      "失败时修改",
    );
  });
});
