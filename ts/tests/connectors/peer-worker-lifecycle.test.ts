import {expect, it, vi} from "vitest";
import {createWorkerPeerLifecycle} from "../../src/connectors/peer-worker-lifecycle.js";
it.each([true, false])("requires both facts in either order (%s)", exitFirst => {
  const latch = createWorkerPeerLifecycle(), handle = {finalize:vi.fn(), abandon:vi.fn()};
  latch.attach(handle);
  (exitFirst ? latch.markExited : latch.markFinalized)();
  expect(handle.finalize).not.toHaveBeenCalled();
  (exitFirst ? latch.markFinalized : latch.markExited)();
  latch.markExited(); latch.markFinalized();
  expect(handle.finalize).toHaveBeenCalledTimes(1);
});
it("replays completion on late attachment", () => {
  const latch = createWorkerPeerLifecycle(), handle = {finalize:vi.fn(), abandon:vi.fn()};
  latch.markFinalized(); latch.markExited(); latch.attach(handle);
  expect(handle.finalize).toHaveBeenCalledTimes(1);
});
it.each([true, false])("abandon disconnects attached or late handle (%s)", early => {
  const latch = createWorkerPeerLifecycle(), handle = {finalize:vi.fn(), abandon:vi.fn()};
  if (early) latch.attach(handle);
  latch.abandon();
  if (!early) latch.attach(handle);
  latch.markExited(); latch.markFinalized();
  expect(handle.abandon).toHaveBeenCalledTimes(1);
  expect(handle.finalize).not.toHaveBeenCalled();
});
it("contains handle errors", () => {
  const latch = createWorkerPeerLifecycle();
  latch.attach({finalize() {throw Error("peer");}, abandon() {throw Error("peer");}});
  latch.markExited();
  expect(() => latch.markFinalized()).not.toThrow();
  expect(() => latch.abandon()).not.toThrow();
});

// Test the private launcher boundary with a controllable child, without sockets.
vi.mock("node:child_process", async original => ({...await original<typeof import("node:child_process")>(),spawn:vi.fn()}));

it.each(["ready","timeout","wrong-id","send-timeout","error","abandon"])("IPC handle bounds %s and never leaks errors", async mode => {
  const {EventEmitter} = await import("node:events");
  const {mkdtemp,rm} = await import("node:fs/promises");
  const {spawn} = await import("node:child_process");
  const {spawnPeerSidecar} = await import("../../src/connectors/peer-sidecar.js");
  const dir = await mkdtemp("/tmp/sp-");
  const child = Object.assign(new EventEmitter(),{
    connected:true, channel:{unref:vi.fn()}, unref:vi.fn(),
    disconnect:vi.fn(), send:vi.fn(),
  });
  child.disconnect.mockImplementation(() => {child.connected = false; child.emit("disconnect");});
  child.send.mockImplementation((_message,callback) => {if (mode !== "send-timeout") callback(null); return true;});
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ReturnType<typeof spawn>;
  });
  try {
    const handle = await spawnPeerSidecar({ownerKind:"claude-worker",runId:"abcdef123456",runDir:dir,streamPath:dir+"/stream",cwd:dir,name:"test",sessionsDir:dir,sockDir:dir});
    expect(handle).toBeDefined(); expect(child.channel.unref).toHaveBeenCalled();
    handle!.finalize(); handle!.finalize();
    expect(child.send).not.toHaveBeenCalled();
    if (mode === "ready" || mode === "send-timeout") {
      child.emit("message",{type:"owner-ready",runId:"abcdef123456"});
      expect(child.send).toHaveBeenCalledTimes(1);
      expect(child.send.mock.calls[0]![0]).toEqual({type:"run-finalized",runId:"abcdef123456"});
    } else if (mode === "wrong-id") child.emit("message",{type:"owner-ready",runId:"ffffffffffff"});
    else if (mode === "error") child.emit("error",Error("closed"));
    else if (mode === "abandon") handle!.abandon();
    await vi.waitFor(() => expect(child.disconnect).toHaveBeenCalledTimes(1),{timeout:2500});
    child.emit("message",{type:"owner-ready",runId:"abcdef123456"});
    handle!.finalize(); handle!.abandon();
    expect(() => child.emit("error",Error("late channel error"))).not.toThrow();
    expect(child.listenerCount("message")).toBe(0);
    expect(child.listenerCount("disconnect")).toBe(0);
    if (mode !== "ready" && mode !== "send-timeout") expect(child.send).not.toHaveBeenCalled();
  } finally {await rm(dir,{recursive:true,force:true});}
});
