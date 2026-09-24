import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  MAX_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
} from "./attachments.js";

const contentTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
};
const execFileAsync = promisify(execFile);

function attachmentLimit(extension: string): number | null {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) {
    return MAX_ATTACHMENT_BYTES;
  }
  if (extension === ".pdf") return MAX_PDF_ATTACHMENT_BYTES;
  if ([".txt", ".md", ".csv"].includes(extension)) {
    return MAX_TEXT_ATTACHMENT_BYTES;
  }
  return null;
}

function formatLimit(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

function isOutsideWorkspace(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

async function openedFilePath(
  fd: number,
  signal: AbortSignal,
): Promise<string> {
  if (process.platform === "linux") {
    return realpath(`/proc/self/fd/${fd}`);
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(process.pid), "-d", String(fd), "-F0n"],
      { encoding: "utf8", maxBuffer: 64 * 1024, signal, timeout: 5_000 },
    );
    const path = stdout
      .split("\0")
      .find((field) => field.startsWith("n"))
      ?.slice(1);
    if (path === undefined || !isAbsolute(path)) {
      throw new Error("Could not verify the opened attachment path");
    }
    return path;
  }
  throw new Error(`File attachments are not supported on ${process.platform}`);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async readAttachment({ path, workspaceRoot }, context) {
      context.signal.throwIfAborted();
      if (isAbsolute(path)) {
        throw new Error(
          "Attachment paths must be relative to the thread workspace",
        );
      }
      if (!isAbsolute(workspaceRoot)) {
        throw new Error("The thread workspace path must be absolute");
      }
      const root = await realpath(workspaceRoot);
      const filePath = await realpath(resolve(root, path));
      const extension = extname(path).toLowerCase();
      const maxBytes = attachmentLimit(extension);
      if (isOutsideWorkspace(root, filePath)) {
        throw new Error(`Attachment is outside the thread workspace: ${path}`);
      }
      const file = await open(
        filePath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const [openedStat, descriptorPath] = await Promise.all([
          file.stat(),
          openedFilePath(file.fd, context.signal),
        ]);
        if (isOutsideWorkspace(root, descriptorPath)) {
          throw new Error(
            `Attachment is outside the thread workspace: ${path}`,
          );
        }
        if (!openedStat.isFile())
          throw new Error(`Attachment is not a file: ${path}`);
        if (maxBytes === null) {
          throw new Error(
            `Unsupported attachment type ${extension || "(none)"}: ${path}`,
          );
        }
        if (openedStat.size > maxBytes) {
          throw new Error(
            `Attachment exceeds ${formatLimit(maxBytes)}: ${path}`,
          );
        }
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          context.signal.throwIfAborted();
          const { bytesRead } = await file.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > maxBytes) {
          throw new Error(
            `Attachment exceeds ${formatLimit(maxBytes)}: ${path}`,
          );
        }
        return {
          filename: basename(path),
          contentType: contentTypes[extension]!,
          base64: bytes.subarray(0, length).toString("base64"),
          identity: `${openedStat.dev}:${openedStat.ino}`,
        };
      } finally {
        await file.close();
      }
    },
  },
});
