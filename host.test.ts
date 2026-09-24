import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import hostEntry from "./host.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
} from "./attachments.js";

vi.mock("@get-bb/plugin-sdk/host", () => ({
  experimental_defineHostEntry: <T extends object>(entry: T) => ({
    experimental_apiVersion: 1,
    ...entry,
  }),
}));

const signal = new AbortController().signal;
const hostContext = {
  signal,
  lifecycle: { signal },
  experimental_paths: { dataDir: "/tmp", tempDir: "/tmp" },
  experimental_emitSignal: async () => undefined,
  experimental_watch: async () => ({ dispose: async () => undefined }),
  experimental_retainWorker: () => ({ dispose: async () => undefined }),
} satisfies ExperimentalHostRpcContext;

function readAttachment(input: { path: string; workspaceRoot: string }) {
  return hostEntry.handlers.readAttachment(input, hostContext);
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it("reads the actual bytes relative to the thread directory and rejects oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "korey-files-"));
  directories.push(directory);
  await writeFile(join(directory, "spec.md"), "# Specification");
  await writeFile(
    join(directory, "large.png"),
    Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
  );
  await writeFile(
    join(directory, "large.md"),
    Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1),
  );
  await writeFile(
    join(directory, "large.pdf"),
    Buffer.alloc(MAX_PDF_ATTACHMENT_BYTES + 1),
  );
  await writeFile(join(directory, "archive.zip"), "unsupported");
  const file = await readAttachment({
    path: "spec.md",
    workspaceRoot: directory,
  });
  expect(file).toEqual({
    filename: "spec.md",
    contentType: "text/markdown",
    base64: Buffer.from("# Specification").toString("base64"),
    identity: expect.stringMatching(/^\d+:\d+$/u),
  });
  await expect(
    readAttachment({
      path: "large.png",
      workspaceRoot: directory,
    }),
  ).rejects.toThrow("exceeds 3 MiB");
  await expect(
    readAttachment({
      path: "large.md",
      workspaceRoot: directory,
    }),
  ).rejects.toThrow("exceeds 0.5 MiB");
  await expect(
    readAttachment({
      path: "large.pdf",
      workspaceRoot: directory,
    }),
  ).rejects.toThrow("exceeds 2.5 MiB");
  await expect(
    readAttachment({
      path: "archive.zip",
      workspaceRoot: directory,
    }),
  ).rejects.toThrow("Unsupported attachment type .zip");
  await expect(
    readAttachment({
      path: ".",
      workspaceRoot: directory,
    }),
  ).rejects.toThrow("not a file");
});

it("rejects absolute paths, traversal, and symlinks outside the thread workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "korey-files-"));
  directories.push(directory);
  const workspaceRoot = join(directory, "workspace");
  const outsidePath = join(directory, "outside.md");
  await mkdir(workspaceRoot);
  await writeFile(outsidePath, "private");
  await symlink(outsidePath, join(workspaceRoot, "outside-link.md"));
  await expect(
    readAttachment({
      path: outsidePath,
      workspaceRoot,
    }),
  ).rejects.toThrow("must be relative");
  await expect(
    readAttachment({
      path: "../outside.md",
      workspaceRoot,
    }),
  ).rejects.toThrow("outside the thread workspace");
  await expect(
    readAttachment({
      path: "outside-link.md",
      workspaceRoot,
    }),
  ).rejects.toThrow("outside the thread workspace");
});

it("returns one identity for aliases of the same workspace file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "korey-files-"));
  directories.push(directory);
  await writeFile(join(directory, "spec.md"), "same file");
  await link(join(directory, "spec.md"), join(directory, "hard-link.md"));
  await symlink("spec.md", join(directory, "symbolic-link.md"));

  const [original, hardLink, symbolicLink] = await Promise.all([
    readAttachment({ path: "spec.md", workspaceRoot: directory }),
    readAttachment({ path: "hard-link.md", workspaceRoot: directory }),
    readAttachment({ path: "symbolic-link.md", workspaceRoot: directory }),
  ]);

  expect(hardLink.identity).toBe(original.identity);
  expect(symbolicLink.identity).toBe(original.identity);
});
