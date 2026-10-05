import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import type { ProjectStorage } from "../src/shared/repositories/projectRepository";
import type {
  WorkspaceChanges,
  WorkspaceMetaRecord,
  WorkspaceSnapshot,
} from "../src/shared/services/indexedDbService";
import {
  EXAMPLE_PROJECT,
  type LatencyProject,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

const LS_META_KEY = "latency-lab.workspace.v2.meta";
const LS_PROJECT_PREFIX = "latency-lab.workspace.v2.project.";
const LEGACY_KEY = "latency-lab.workspace.v1";

class MemoryStorage implements ProjectStorage {
  meta?: WorkspaceMetaRecord;
  projects = new Map<string, unknown>();
  legacy?: unknown;
  failWrite = false;
  writes: WorkspaceChanges[] = [];

  async read(): Promise<WorkspaceSnapshot> {
    return {
      meta: this.meta ? structuredClone(this.meta) : undefined,
      projects: [...this.projects.values()].map((value) =>
        structuredClone(value),
      ),
      legacy: this.legacy ? structuredClone(this.legacy) : undefined,
    };
  }

  async write(changes: WorkspaceChanges): Promise<void> {
    this.writes.push(structuredClone(changes));
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    for (const project of changes.upserts)
      this.projects.set(project.id, structuredClone(project));
    for (const id of changes.removedIds) this.projects.delete(id);
    this.meta = structuredClone(changes.meta);
    if (changes.clearLegacy) this.legacy = undefined;
  }
}

function workspace(projects: LatencyProject[]): WorkspaceDocument {
  return {
    activeProjectId: projects[0]!.id,
    projects,
  };
}

function withTitle(project: LatencyProject, title: string): LatencyProject {
  return { ...project, title, updatedAt: Date.now() };
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.meta = {
      revision: 99,
      activeProjectId: "ghost",
      projectIds: ["ghost"],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("migrates a legacy whole-workspace IndexedDB record into per-project rows", async () => {
    const storage = new MemoryStorage();
    storage.legacy = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    const repository = new ProjectRepository(storage);
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(storage.legacy).toBeUndefined();
    const normalize = storage.writes[0]!;
    expect(normalize.clearLegacy).toBe(true);
    expect(normalize.upserts.map((p) => p.id)).toEqual([EXAMPLE_PROJECT.id]);
    expect(normalize.meta.projectIds).toEqual([EXAMPLE_PROJECT.id]);

    // 再次打开两层已一致，不再重复转换，也不再标记恢复。
    const reloaded = await new ProjectRepository(storage).load();
    expect(reloaded.recovered).toBe(false);
    expect(reloaded.document).toEqual(loaded.document);
  });

  it("migrates the legacy local recovery copy and removes the old key", async () => {
    const storage = new MemoryStorage();
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        version: 1,
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [structuredClone(EXAMPLE_PROJECT)],
      }),
    );
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    const meta = JSON.parse(
      localStorage.getItem(LS_META_KEY) ?? "null",
    ) as WorkspaceMetaRecord | null;
    expect(meta?.projectIds).toEqual([EXAMPLE_PROJECT.id]);
    expect(
      localStorage.getItem(LS_PROJECT_PREFIX + EXAMPLE_PROJECT.id),
    ).not.toBeNull();
  });

  it("writes only the changed project and meta when one project is edited", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const other: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "project-other",
      title: "另一个项目",
    };
    await repository.load();
    await repository.save(workspace([structuredClone(EXAMPLE_PROJECT), other]));
    storage.writes.length = 0;

    const edited = withTitle(
      storage.projects.get(EXAMPLE_PROJECT.id) as LatencyProject,
      "新的项目名",
    );
    await repository.save({
      activeProjectId: edited.id,
      projects: [edited, other],
    });

    const write = storage.writes[0]!;
    expect(write.upserts.map((project) => project.id)).toEqual([
      EXAMPLE_PROJECT.id,
    ]);
    expect(write.removedIds).toEqual([]);
    expect(write.meta.revision).toBe(2);
    expect((storage.projects.get(other.id) as LatencyProject).title).toBe(
      "另一个项目",
    );
  });

  it("writes only meta when switching the active project", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const other: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "project-other",
      title: "另一个项目",
    };
    await repository.load();
    await repository.save(workspace([structuredClone(EXAMPLE_PROJECT), other]));
    storage.writes.length = 0;

    await repository.save({
      activeProjectId: other.id,
      projects: [structuredClone(EXAMPLE_PROJECT), other],
    });
    const write = storage.writes[0]!;
    expect(write.upserts).toEqual([]);
    expect(write.removedIds).toEqual([]);
    expect(write.meta.activeProjectId).toBe(other.id);
  });

  it("removes a single project row when a project is deleted", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const other: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "project-other",
      title: "另一个项目",
    };
    await repository.load();
    await repository.save(workspace([structuredClone(EXAMPLE_PROJECT), other]));
    storage.writes.length = 0;

    await repository.save(workspace([other]));
    const write = storage.writes[0]!;
    expect(write.upserts).toEqual([]);
    expect(write.removedIds).toEqual([EXAMPLE_PROJECT.id]);
    expect(storage.projects.has(EXAMPLE_PROJECT.id)).toBe(false);
    expect(write.meta.projectIds).toEqual(["project-other"]);
  });

  it("prefers the layer with the newer revision when the two diverge", async () => {
    const storage = new MemoryStorage();
    // IndexedDB 停留在旧版本
    storage.meta = { revision: 1, activeProjectId: "p1", projectIds: ["p1"] };
    storage.projects.set("p1", {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "p1",
      title: "IndexedDB 旧标题",
    });
    // localStorage 恢复副本是更新的一次成功写入
    localStorage.setItem(
      LS_META_KEY,
      JSON.stringify({
        revision: 2,
        activeProjectId: "p1",
        projectIds: ["p1"],
      }),
    );
    localStorage.setItem(
      LS_PROJECT_PREFIX + "p1",
      JSON.stringify({
        ...structuredClone(EXAMPLE_PROJECT),
        id: "p1",
        title: "恢复副本新标题",
      }),
    );

    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects[0]?.title).toBe("恢复副本新标题");
    expect(loaded.recovered).toBe(true);
    // 收敛后 IndexedDB 追上恢复副本
    expect((storage.projects.get("p1") as LatencyProject).title).toBe(
      "恢复副本新标题",
    );
    expect(storage.meta?.revision).toBe(2);
  });

  it("prefers IndexedDB when revisions are equal", async () => {
    const storage = new MemoryStorage();
    storage.meta = { revision: 2, activeProjectId: "p1", projectIds: ["p1"] };
    storage.projects.set("p1", {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "p1",
      title: "IndexedDB 内容",
    });
    localStorage.setItem(
      LS_META_KEY,
      JSON.stringify({
        revision: 2,
        activeProjectId: "p1",
        projectIds: ["p1"],
      }),
    );
    localStorage.setItem(
      LS_PROJECT_PREFIX + "p1",
      JSON.stringify({
        ...structuredClone(EXAMPLE_PROJECT),
        id: "p1",
        title: "恢复副本内容",
      }),
    );
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects[0]?.title).toBe("IndexedDB 内容");
  });

  it("keeps readable projects while dropping malformed rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.meta = {
      revision: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projectIds: [EXAMPLE_PROJECT.id, "broken"],
    };
    storage.projects.set(EXAMPLE_PROJECT.id, {
      ...structuredClone(EXAMPLE_PROJECT),
      nodes: [
        { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
        { damaged: true },
      ],
    });
    storage.projects.set("broken", { id: 9, title: null });
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    await repository.load();
    storage.failWrite = true;
    await expect(
      repository.save({
        activeProjectId: EXAMPLE_PROJECT.id,
        projects: [withTitle(structuredClone(EXAMPLE_PROJECT), "失败前的修改")],
      }),
    ).rejects.toThrow("IndexedDB quota failure");

    storage.failWrite = false;
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects[0]?.title).toBe("失败前的修改");
    expect(loaded.recovered).toBe(true);
  });

  it("keeps the recovery copy restorable as a whole workspace", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const other: LatencyProject = {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "project-other",
      title: "另一个项目",
    };
    await repository.load();
    await repository.save(workspace([structuredClone(EXAMPLE_PROJECT), other]));

    const meta = JSON.parse(
      localStorage.getItem(LS_META_KEY) ?? "null",
    ) as WorkspaceMetaRecord | null;
    expect(meta).toBeTruthy();
    const restored = meta!.projectIds.map(
      (id) =>
        JSON.parse(
          localStorage.getItem(LS_PROJECT_PREFIX + id) ?? "null",
        ) as LatencyProject,
    );
    expect(restored.map((project) => project.id).sort()).toEqual(
      [EXAMPLE_PROJECT.id, "project-other"].sort(),
    );
  });

  it("cleans up orphan project keys after normalization", async () => {
    const storage = new MemoryStorage();
    storage.meta = { revision: 1, activeProjectId: "p1", projectIds: ["p1"] };
    storage.projects.set("p1", {
      ...structuredClone(EXAMPLE_PROJECT),
      id: "p1",
    });
    localStorage.setItem(
      LS_META_KEY,
      JSON.stringify({
        revision: 1,
        activeProjectId: "p1",
        projectIds: ["p1"],
      }),
    );
    localStorage.setItem(
      LS_PROJECT_PREFIX + "p1",
      JSON.stringify({ ...structuredClone(EXAMPLE_PROJECT), id: "p1" }),
    );
    localStorage.setItem(
      LS_PROJECT_PREFIX + "orphan",
      JSON.stringify({ ...structuredClone(EXAMPLE_PROJECT), id: "orphan" }),
    );
    await new ProjectRepository(storage).load();
    expect(localStorage.getItem(LS_PROJECT_PREFIX + "orphan")).toBeNull();
  });
});
