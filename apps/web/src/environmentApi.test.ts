import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";

function createRpcClientStub() {
  const request = vi.fn();
  const subscribe = vi.fn(() => vi.fn());

  return {
    terminal: {
      open: request,
      write: request,
      resize: request,
      clear: request,
      restart: request,
      close: request,
      onEvent: subscribe,
    },
    projects: {
      searchEntries: request,
      writeFile: request,
    },
    filesystem: {
      browse: request,
    },
    git: {
      pull: request,
      refreshStatus: request,
      onStatus: subscribe,
      listBranches: request,
      createWorktree: request,
      removeWorktree: request,
      createBranch: request,
      checkout: request,
      init: request,
      resolvePullRequest: request,
      preparePullRequestThread: request,
    },
    orchestration: {
      dispatchCommand: request,
      getTurnDiff: request,
      getFullThreadDiff: request,
      subscribeShell: subscribe,
      subscribeThread: subscribe,
    },
  };
}

describe("readEnvironmentApi", () => {
  afterEach(() => {
    vi.doUnmock("./environments/runtime");
    vi.doUnmock("./environments/primary");
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lazily creates the primary environment API when the connection has not been registered yet", async () => {
    const environmentId = EnvironmentId.make("environment-local");
    const rpcClient = createRpcClientStub();
    const getPrimaryEnvironmentConnection = vi.fn(() => ({
      environmentId,
      client: rpcClient,
    }));

    vi.stubGlobal("window", {});
    vi.doMock("./environments/runtime", () => ({
      readEnvironmentConnection: vi.fn(() => null),
      getPrimaryEnvironmentConnection,
    }));
    vi.doMock("./environments/primary", () => ({
      getPrimaryKnownEnvironment: vi.fn(() => ({
        environmentId,
      })),
    }));

    const { readEnvironmentApi } = await import("./environmentApi");

    expect(readEnvironmentApi(environmentId)?.filesystem.browse).toBe(rpcClient.filesystem.browse);
    expect(getPrimaryEnvironmentConnection).toHaveBeenCalledTimes(1);
  });
});
